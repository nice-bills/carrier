import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { Pocket, PayError, nowSeconds, type FeedEvent, type SettlementReceipt } from "./pocket";
import { noteKey } from "./chain";
import { formatAmount } from "./amounts";
import { shorten } from "./format";
import { BOND_BPS, PROBE_INTERVAL_MS, REFRESH_INTERVAL_MS } from "./config";
import { slotVerdict } from "./ledger";
import { WalletError } from "./wallet-error";
import { announce } from "./ui/kit";
import type { AppWallet, Balances, Radio, Services } from "./services/types";

/**
 * Everything the screens show and every action they can take, in one hook.
 * Screens are drawn from this; they hold no state of their own beyond what a
 * text field or a finger needs.
 */

export type RadioState =
  | { state: "off" }
  | { state: "starting" }
  | { state: "on" }
  | { state: "needs-permission"; blocked: boolean }
  | { state: "unavailable"; reason: string };

export type Boot =
  | { state: "loading" }
  | { state: "onboarding"; wallet: AppWallet | null; pocket: Pocket | null }
  | { state: "ready"; wallet: AppWallet; pocket: Pocket; dropped: number }
  | { state: "failed"; message: string };

export type Online = "unknown" | "online" | "offline";

export interface Toast {
  id: number;
  text: string;
}

/** The settlement moment: shown as a banner with the SETTLED stamp. */
export interface Moment {
  id: number;
  text: string;
}

/** How long to wait for a handed note to be taken before saying it was not. */
const HAND_WAIT_MS = 15_000;
/** How often to ask each nearby phone what it could hand us. */
const HOLDINGS_EVERY_MS = 5_000;
/** Other people's pouches checked per refresh, to notice settlements. */
const MAX_WATCHED_PER_REFRESH = 12;

export function useCarrier(services: Services) {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [radio, setRadio] = useState<RadioState>({ state: "off" });
  const [peers, setPeers] = useState<PublicKey[]>([]);
  const [holdings, setHoldings] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState<Online>("unknown");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [settling, setSettling] = useState<Record<string, boolean>>({});
  const [settleErrors, setSettleErrors] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [pouchBusy, setPouchBusy] = useState<string | null>(null);
  const [pouchError, setPouchError] = useState<string | null>(null);
  const [firstHandoff, setFirstHandoff] = useState(false);

  const radioRef = useRef<Radio | null>(null);
  const pulling = useRef(new Set<string>());
  const radioGen = useRef(0);
  const ids = useRef(0);
  const handTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const pocket = boot.state === "ready" || boot.state === "onboarding" ? boot.pocket : null;
  const wallet = boot.state === "ready" || boot.state === "onboarding" ? boot.wallet : null;

  const say = useCallback((text: string, speak = true) => {
    ids.current += 1;
    setToast({ id: ids.current, text });
    if (speak) announce(text);
  }, []);

  // --- boot -----------------------------------------------------------------------

  const failMessage = (e: unknown) =>
    e instanceof WalletError && e.code === "corrupt-key"
      ? "This phone's saved key is damaged. Carrier will not replace it on its own, because payments signed with it would be lost."
      : e instanceof WalletError
        ? "The phone's secure storage is not answering. Nothing was changed."
        : `Carrier could not start: ${(e as Error).message}`;

  const load = useCallback(async () => {
    setBoot({ state: "loading" });
    try {
      const w = await services.existingWallet();
      if (!w) {
        setBoot({ state: "onboarding", wallet: null, pocket: null });
        return;
      }
      const { pocket: p, report } = await services.openPocket(w);
      setBoot(p.onboarded ? { state: "ready", wallet: w, pocket: p, dropped: report.dropped } : { state: "onboarding", wallet: w, pocket: p });
    } catch (e) {
      setBoot({ state: "failed", message: failMessage(e) });
    }
  }, [services]);

  useEffect(() => {
    load();
  }, [load]);

  /** First run: make the key (or find it) and open the pocket. */
  const makeKey = useCallback(async () => {
    try {
      const w = await services.createWallet();
      const { pocket: p } = await services.openPocket(w);
      setBoot({ state: "onboarding", wallet: w, pocket: p });
      announce("Key made. It stays on this phone.");
    } catch (e) {
      setBoot({ state: "failed", message: failMessage(e) });
    }
  }, [services]);

  const finishOnboarding = useCallback(async () => {
    if (boot.state !== "onboarding" || !boot.wallet || !boot.pocket) return;
    await boot.pocket.finishOnboarding().catch(() => {});
    setBoot({ state: "ready", wallet: boot.wallet, pocket: boot.pocket, dropped: 0 });
  }, [boot]);

  // --- pocket events ---------------------------------------------------------------

  useEffect(() => {
    if (!pocket) return;
    const offChange = pocket.subscribe(() => setVersion((v) => v + 1));
    const offEvent = pocket.onEvent((e: FeedEvent) => {
      if (e.kind === "settled-elsewhere") {
        ids.current += 1;
        setMoment({ id: ids.current, text: e.text });
        announce(e.text);
        return;
      }
      if (e.kind === "settled") return; // the receipt sheet announces this one
      if (e.kind === "took" || e.kind === "received" || e.kind === "paid-to-you" || e.kind === "handed" || e.kind === "delivered") {
        setFirstHandoff(true);
      }
      if (e.kind === "handed" || e.kind === "delivered") {
        for (const [hash, t] of handTimers.current) {
          if (!pocket.node.holds(hash)) {
            clearTimeout(t);
            handTimers.current.delete(hash);
          }
        }
      }
      say(e.text);
    });
    return () => {
      offChange();
      offEvent();
    };
  }, [pocket, say]);

  // --- radio -----------------------------------------------------------------------

  const refreshPeers = useCallback(async () => {
    if (!pocket) return;
    await pocket.prune().catch(() => {});
    const r = radioRef.current;
    setPeers(r ? await r.peers() : []);
  }, [pocket]);

  const pullFrom = useCallback(
    async (peer: PublicKey, only?: string[]) => {
      const r = radioRef.current;
      if (!pocket || !r) return [] as Bundle[];
      const k = peer.toBase58();
      if (pulling.current.has(k)) return [] as Bundle[];
      pulling.current.add(k);
      try {
        return await pocket.pull(r, peer, only);
      } catch {
        return [] as Bundle[];
      } finally {
        pulling.current.delete(k);
        setHoldings((h) => ({ ...h, [k]: 0 }));
      }
    },
    [pocket],
  );

  const stopRadio = useCallback(async () => {
    radioGen.current += 1;
    const r = radioRef.current;
    radioRef.current = null;
    setRadio({ state: "off" });
    setPeers([]);
    setHoldings({});
    await r?.stop().catch(() => {});
  }, []);

  const startRadio = useCallback(async () => {
    if (!pocket || !wallet || radioRef.current) return;
    const gen = radioGen.current;
    const cancelled = () => gen !== radioGen.current;
    setRadio({ state: "starting" });
    try {
      const perms = await services.requestRadioPermissions();
      if (cancelled()) return;
      if (!perms.granted) {
        setRadio({ state: "needs-permission", blocked: perms.blocked });
        return;
      }
      const why = await services.radioUnavailable();
      if (cancelled()) return;
      if (why) {
        setRadio({ state: "unavailable", reason: why });
        return;
      }
      const r = services.createRadio(wallet, pocket, {
        peerReady: (peer) => {
          pocket.noteNearby(peer, true);
          refreshPeers();
        },
        peerGone: (peer) => {
          pocket.noteNearby(peer, false);
          refreshPeers();
        },
        handed: (peer, digests) => {
          pullFrom(peer, digests).finally(() => refreshPeers());
        },
        error: (where, e) => {
          if (__DEV__) console.warn(`[radio] ${where}:`, e);
        },
      });
      radioRef.current = r;
      await r.advertise(wallet.publicKey);
      if (cancelled()) {
        await r.stop().catch(() => {});
        return;
      }
      setRadio({ state: "on" });
      refreshPeers();
    } catch (e) {
      if (cancelled()) return;
      radioRef.current = null;
      setRadio({ state: "unavailable", reason: `The radio would not start: ${(e as Error).message}` });
    }
  }, [pocket, wallet, services, refreshPeers, pullFrom]);

  // Radio down when the pocket goes away (or the app unmounts)...
  useEffect(() => {
    if (!pocket) return;
    return () => {
      stopRadio();
    };
  }, [pocket, stopRadio]);

  // ...and up once first run is done, unless it is already on (first run
  // turns it on itself for the handoff step).
  const isReady = boot.state === "ready";
  useEffect(() => {
    if (isReady && !radioRef.current) startRadio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, pocket]);

  // Peers come and go constantly and a render per radio event would thrash.
  // Once a second is faster than anyone walks.
  useEffect(() => {
    if (!pocket) return;
    const id = setInterval(() => {
      refreshPeers().catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [pocket, refreshPeers]);

  // What could each nearby person hand us? Asked every few seconds.
  useEffect(() => {
    if (!pocket || radio.state !== "on") return;
    const tick = async () => {
      const r = radioRef.current;
      if (!r) return;
      const next: Record<string, number> = {};
      for (const p of await r.peers()) {
        try {
          const ds = await r.digests(p);
          next[p.toBase58()] = ds.filter((d) => pocket.couldTake(d)).length;
        } catch {
          // out of range or slow: leave them at zero
        }
      }
      setHoldings(next);
    };
    tick();
    const id = setInterval(tick, HOLDINGS_EVERY_MS);
    return () => clearInterval(id);
  }, [pocket, radio.state, peers.length]);

  // --- handing on, taking, paying ----------------------------------------------------

  /** Hand one slip to a nearby person. They take it; we hear their signature. */
  const pass = useCallback(
    async (noteHash: string, peer: PublicKey) => {
      const r = radioRef.current;
      if (!pocket || !r) {
        say("The radio is off. Turn it on to hand this over.");
        return;
      }
      if (!peers.some((p) => p.equals(peer))) {
        say(`${shorten(peer)} walked out of range. The payment is still in your pocket.`);
        return;
      }
      try {
        pocket.handTo(noteHash, peer);
        await r.hand(peer, [noteHash]);
      } catch (e) {
        pocket.cancelHand(noteHash);
        say(`Could not hand it over: ${(e as Error).message}. It is still in your pocket.`);
        return;
      }
      say(`Handing it to ${shorten(peer)}. Keep the phones close.`);
      const old = handTimers.current.get(noteHash);
      if (old) clearTimeout(old);
      handTimers.current.set(
        noteHash,
        setTimeout(() => {
          handTimers.current.delete(noteHash);
          if (pocket.node.holds(noteHash)) {
            pocket.cancelHand(noteHash);
            say(`${shorten(peer)}'s phone did not take it. It is still in your pocket.`);
          }
        }, HAND_WAIT_MS),
      );
    },
    [pocket, peers, say],
  );

  const take = useCallback(
    async (peer: PublicKey) => {
      const got = await pullFrom(peer);
      if (!got.length) say(`${shorten(peer)} had nothing they could hand you.`);
    },
    [pullFrom, say],
  );

  /** Sign a payment; if the recipient is nearby, hand it straight to them. */
  const pay = useCallback(
    async (to: PublicKey, amount: bigint, relayFeeBps: number): Promise<{ ok: true; bundle: Bundle } | { ok: false; message: string }> => {
      if (!pocket) return { ok: false, message: "Carrier is still opening." };
      try {
        const bundle = await pocket.pay({
          to,
          amount,
          relayFeeBps,
          pickSlot: (c, used) => services.chain.nextFreeSlot(c, used),
        });
        if (peers.some((p) => p.equals(to))) await pass(noteKey(bundle), to);
        return { ok: true, bundle };
      } catch (e) {
        return { ok: false, message: e instanceof PayError ? e.message : `Not signed: ${(e as Error).message}` };
      }
    },
    [pocket, peers, pass, services],
  );

  // --- online: pouch, settlements --------------------------------------------------

  const refreshOnline = useCallback(async () => {
    if (!pocket || !wallet) return false;
    const ok = await services.chain.probe();
    setOnline(ok ? "online" : "offline");
    if (!ok) return false;
    try {
      const own = await services.chain.fetchPouch(services.chain.pouchAddress(wallet.publicKey));
      if (own) pocket.observePouch(own);
      setBalances(await services.chain.balances(wallet.publicKey));
      const mine = own?.address;
      for (const address of pocket.watchedPouches().filter((a) => a !== mine).slice(0, MAX_WATCHED_PER_REFRESH)) {
        const p = await services.chain.fetchPouch(new PublicKey(address)).catch(() => null);
        if (!p) continue;
        pocket.observeOther(address, p.epoch, (slot, hash) => slotVerdict(p, slot, hash));
      }
      if (own) pocket.observeOther(own.address, own.epoch, (slot, hash) => slotVerdict(own, slot, hash));
    } catch {
      // A failed refresh leaves the last known state in place.
    }
    setVersion((v) => v + 1);
    return true;
  }, [pocket, wallet, services]);

  useEffect(() => {
    if (!pocket || boot.state !== "ready") return;
    let last = 0;
    const tick = async () => {
      const now = Date.now();
      // Probe often, refresh the pouch less often.
      if (now - last >= REFRESH_INTERVAL_MS || online !== "online") {
        if (await refreshOnline()) last = now;
      } else {
        const ok = await services.chain.probe();
        setOnline(ok ? "online" : "offline");
      }
    };
    tick();
    const id = setInterval(tick, PROBE_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pocket, boot.state]);

  const settle = useCallback(
    async (noteHash: string) => {
      if (!pocket || !wallet) return;
      const bundle = pocket.node.bundle(noteHash);
      if (!bundle) return;
      setSettling((s) => ({ ...s, [noteHash]: true }));
      setSettleErrors((s) => {
        const { [noteHash]: _gone, ...rest } = s;
        return rest;
      });
      try {
        const { signatures } = await services.chain.settle(wallet, bundle);
        const r = pocket.settledHere(bundle, signatures);
        setReceipt(r);
        const mine = r.carriers.find((c) => c.you);
        announce(
          `Settled. ${r.amount}. ${pocket.isForMe(bundle) ? "Paid to you" : `Paid to ${shorten(r.to)}`}` +
            (r.carriers.length ? `, and ${r.carriers.length} ${r.carriers.length === 1 ? "carrier" : "carriers"} paid` : "") +
            (mine ? ", including you." : "."),
        );
        refreshOnline().catch(() => {});
      } catch (e) {
        const text = services.chain.explain(e);
        setSettleErrors((s) => ({ ...s, [noteHash]: text }));
        announce(`Not settled. ${text}`);
      } finally {
        setSettling((s) => {
          const { [noteHash]: _done, ...rest } = s;
          return rest;
        });
      }
    },
    [pocket, wallet, services, refreshOnline],
  );

  const setupPouch = useCallback(
    async (amount: bigint) => {
      if (!wallet) return false;
      setPouchError(null);
      setPouchBusy("Setting aside your allowance");
      try {
        const bond = (amount * BigInt(BOND_BPS)) / 10_000n;
        await services.chain.openPouch(wallet, amount, bond);
        await refreshOnline();
        say("Your pouch is set up. You can pay people offline now.");
        return true;
      } catch (e) {
        const text = services.chain.explain(e);
        setPouchError(text);
        announce(`Pouch not set up. ${text}`);
        return false;
      } finally {
        setPouchBusy(null);
      }
    },
    [wallet, services, refreshOnline, say],
  );

  const airdrop = useCallback(async () => {
    if (!wallet) return;
    setPouchError(null);
    setPouchBusy("Asking devnet for test SOL");
    try {
      await services.chain.airdrop(wallet.publicKey);
      setBalances(await services.chain.balances(wallet.publicKey));
      say("Test SOL arrived. It pays the network fees.");
    } catch (e) {
      const text = services.chain.explain(e);
      setPouchError(text);
      announce(text);
    } finally {
      setPouchBusy(null);
    }
  }, [wallet, services, say]);

  // --- derived ------------------------------------------------------------------------

  const slips = useMemo(() => (pocket ? pocket.list() : []), [pocket, version]);
  const spendable = useMemo(() => (pocket ? pocket.spendable(nowSeconds()) : 0n), [pocket, version]);

  return {
    boot,
    load,
    makeKey,
    finishOnboarding,
    pocket,
    wallet,
    version,
    radio,
    startRadio,
    stopRadio,
    peers,
    holdings,
    slips,
    spendable,
    pass,
    take,
    pay,
    online,
    balances,
    refreshOnline,
    settle,
    settling,
    settleErrors,
    receipt,
    closeReceipt: () => setReceipt(null),
    showReceipt: setReceipt,
    setupPouch,
    airdrop,
    pouchBusy,
    pouchError,
    toast,
    dismissToast: () => setToast(null),
    moment,
    dismissMoment: () => setMoment(null),
    firstHandoff,
    say,
    amountText: (b: Bundle) => formatAmount(b).text,
    services,
  };
}

export type Carrier = ReturnType<typeof useCarrier>;
