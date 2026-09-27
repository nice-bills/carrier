import { describe, expect, it } from "vitest";
import { SendTransactionError } from "@solana/web3.js";
import { CarrierClientError, explainError, programErrorCode, SettlementFailedError } from "./errors.js";
import { TransactionFailedError } from "./send.js";

describe("explainError", () => {
  it("reads a preflight failure's custom program error", () => {
    const e = new SendTransactionError({
      action: "send",
      signature: "",
      transactionMessage: "Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1777",
      logs: ["Program log: AnchorError occurred. Error Code: SlotAlreadySpent. Error Number: 6007."],
    });
    expect(programErrorCode(e)).toMatchObject({ code: 6007, name: "SlotAlreadySpent" });
    expect(explainError(e)).toBe("This payment was already settled.");
  });

  it("reads a landed transaction's error object", () => {
    const e = new TransactionFailedError("sig", { InstructionError: [1, { Custom: 6006 }] });
    expect(programErrorCode(e)).toEqual({ code: 6006, name: "NoteExpired", instruction: 1 });
    expect(explainError(e)).toBe("This payment expired before it reached the network.");
    expect(explainError({ InstructionError: [1, { Custom: 6008 }] })).toBe(
      "The sender's pouch does not have enough left to cover this.",
    );
  });

  it("explains client-side refusals and wrapped failures", () => {
    expect(explainError(new CarrierClientError("SlotAlreadySpent", "x"))).toBe("This payment was already settled.");
    expect(explainError(new CarrierClientError("PouchNotFound", "The pouch this payment draws on does not exist."))).toBe(
      "The pouch this payment draws on does not exist.",
    );
    const wrapped = new SettlementFailedError("This payment was already settled.", [], new Error("inner"));
    expect(explainError(wrapped)).toBe("This payment was already settled.");
  });

  it("has plain sentences for common network failures", () => {
    expect(explainError(new Error("Transaction simulation failed: Blockhash not found"))).toMatch(/took too long/);
    expect(explainError(new Error("Attempt to debit an account but found no record of a prior credit."))).toMatch(/SOL/);
    expect(explainError(new TypeError("fetch failed"))).toMatch(/signal/);
    expect(explainError(new Error("Allocate: account Address { .. } already in use"))).toMatch(/already being settled/);
    expect(explainError(new Error("custom program error: 0xbc4"))).toBe("That pouch does not exist.");
    expect(explainError(42)).toBe("Something went wrong. Try again.");
  });

  it("never mentions keys, programs or hex", () => {
    for (let code = 6000; code <= 6030; code += 1) {
      const text = explainError({ InstructionError: [1, { Custom: code }] });
      expect(text).not.toMatch(/0x|program|pubkey|lamport|instruction|ed25519/i);
      expect(text.length).toBeLessThan(100);
    }
  });
});
