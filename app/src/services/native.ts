import { Linking, Share } from "react-native";
import { Connection, type Commitment } from "@solana/web3.js";
import { isPlayServicesAvailable } from "expo-nearby-connections";
import {
  buildOpenPouchTx,
  explainError,
  fetchPouch,
  nextFreeSlot,
  pouchAddress,
  requestDevnetAirdrop,
  settleBundle,
  signSendAndConfirm,
  type PouchState,
} from "@carrier/client";
import { DeviceWallet } from "../wallet";
import { Pocket } from "../pocket";
import { fileStore } from "../store";
import { ensureRadioPermissions } from "../permissions";
import { NearbyTransport } from "../transport/nearby";
import { rehydrate, toCached, type CachedPouch } from "../ledger";
import { AIRDROP_LAMPORTS, CLUSTER, MINT, PROBE_TIMEOUT_MS, RPC_URL } from "../config";
import type { AppWallet, ChainService, Services } from "./types";

/** The real device: keystore, private files, Nearby Connections, Solana RPC. */

const COMMITMENT: Commitment = "confirmed";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function nativeChain(): ChainService {
  // One connection for the app's lifetime; web3.js reuses it for every call.
  const connection = new Connection(RPC_URL, COMMITMENT);

  return {
    cluster: CLUSTER,

    async probe() {
      try {
        await withTimeout(connection.getSlot(COMMITMENT), PROBE_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    },

    pouchAddress(owner) {
      return pouchAddress(owner, MINT);
    },

    async fetchPouch(address) {
      const p = await fetchPouch(connection, address);
      return p ? toCached(p) : null;
    },

    nextFreeSlot(pouch, used) {
      // The client reads `spent`/`isSlotSpent`; the cached form restores both.
      return nextFreeSlot(rehydrate(pouch) as unknown as PouchState, used);
    },

    async balances(owner) {
      const sol = BigInt(await connection.getBalance(owner, COMMITMENT));
      let token: bigint | null = null;
      try {
        const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: MINT }, COMMITMENT);
        token = res.value.reduce((n, a) => {
          const amount = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info
            ?.tokenAmount?.amount;
          return n + (amount && /^\d+$/.test(amount) ? BigInt(amount) : 0n);
        }, 0n);
      } catch {
        token = null;
      }
      return { sol, token };
    },

    async settle(wallet, bundle) {
      return settleBundle(connection, wallet, bundle);
    },

    async openPouch(wallet, amount, bond) {
      const tx = await buildOpenPouchTx(connection, { owner: wallet.publicKey, mint: MINT, amount, bond });
      // Fresh blockhash, sign with the device key, send, wait for confirmation.
      return signSendAndConfirm(connection, wallet, tx, COMMITMENT);
    },

    async airdrop(owner) {
      await requestDevnetAirdrop(connection, owner, AIRDROP_LAMPORTS);
    },

    explain(e) {
      try {
        return explainError(e);
      } catch {
        return e instanceof Error ? e.message : String(e);
      }
    },
  };
}

export function nativeServices(): Services {
  return {
    existingWallet: () => DeviceWallet.existing(),
    createWallet: () => DeviceWallet.load(),
    openPocket: (wallet: AppWallet) => Pocket.open(wallet, fileStore()),
    requestRadioPermissions: () => ensureRadioPermissions(),
    async radioUnavailable() {
      return (await isPlayServicesAvailable())
        ? null
        : "This phone has no Google Play services, which the radio needs.";
    },
    createRadio: (wallet, pocket, events) => new NearbyTransport(wallet, pocket, events),
    chain: nativeChain(),
    openSettings: () => {
      Linking.openSettings().catch(() => {});
    },
    openUrl: (url) => {
      Linking.openURL(url).catch(() => {});
    },
    async share(text) {
      await Share.share({ message: text });
    },
  };
}

