/**
 * Deposit Escrow — devnet CLI
 *
 * Drives the full rental-deposit lifecycle against the deployed program so
 * judges can reproduce it without writing code.
 *
 *   yarn cli init <amountSol> [leaseSeconds]   tenant locks a deposit
 *   yarn cli fund-landlord <sol>               top up landlord for tx fees
 *   yarn cli file-claim <claimSol>             landlord files a damage claim
 *   yarn cli accept                            tenant accepts the claim (split)
 *   yarn cli dispute                           tenant disputes (freeze)
 *   yarn cli timeout                           anyone settles after the window
 *   yarn cli release                           anyone refunds after the grace
 *   yarn cli show                              print on-chain escrow state
 *
 * The default Solana CLI wallet (~/.config/solana/id.json) acts as the TENANT.
 * A landlord keypair is generated once at cli/landlord.json.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import IDL from "../target/idl/deposit_escrow.json";

const PROGRAM_ID = new PublicKey(IDL.address);
const LANDLORD_PATH = path.join(__dirname, "landlord.json");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

function loadOrCreateLandlord(): Keypair {
  if (fs.existsSync(LANDLORD_PATH)) return loadKeypair(LANDLORD_PATH);
  const kp = Keypair.generate();
  fs.writeFileSync(LANDLORD_PATH, JSON.stringify(Array.from(kp.secretKey)));
  console.log("generated landlord keypair:", kp.publicKey.toBase58());
  return kp;
}

function pdas(landlord: PublicKey, tenant: PublicKey) {
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), landlord.toBuffer(), tenant.toBuffer()],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrow.toBuffer()],
    PROGRAM_ID
  );
  return { escrow, vault };
}

function explorer(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  const connection = new Connection(
    process.env.RPC_URL || clusterApiUrl("devnet"),
    "confirmed"
  );
  const tenant = loadKeypair(
    process.env.TENANT_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`
  );
  const landlord = loadOrCreateLandlord();

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(tenant),
    { commitment: "confirmed" }
  );
  const program = new Program(IDL as anchor.Idl, provider);
  const { escrow, vault } = pdas(landlord.publicKey, tenant.publicKey);

  const baseAccounts = {
    landlord: landlord.publicKey,
    tenant: tenant.publicKey,
    escrow,
    vault,
    systemProgram: SystemProgram.programId,
  };

  switch (cmd) {
    case "init": {
      const amountSol = parseFloat(rest[0] ?? "0.1");
      const leaseSeconds = parseInt(rest[1] ?? "30", 10);
      const leaseEnd = Math.floor(Date.now() / 1000) + leaseSeconds;
      const sig = await program.methods
        .initialize(
          new anchor.BN(Math.round(amountSol * LAMPORTS_PER_SOL)),
          new anchor.BN(leaseEnd)
        )
        .accounts(baseAccounts)
        .rpc();
      console.log(`✅ initialized: ${amountSol} SOL locked, lease_end=${leaseEnd}`);
      console.log("   landlord:", landlord.publicKey.toBase58());
      console.log("   escrow:  ", escrow.toBase58());
      console.log("   vault:   ", vault.toBase58());
      console.log("  ", explorer(sig));
      break;
    }
    case "fund-landlord": {
      const sol = parseFloat(rest[0] ?? "0.05");
      const sig = await program.provider.sendAndConfirm!(
        (() => {
          const tx = new anchor.web3.Transaction().add(
            SystemProgram.transfer({
              fromPubkey: tenant.publicKey,
              toPubkey: landlord.publicKey,
              lamports: Math.round(sol * LAMPORTS_PER_SOL),
            })
          );
          return tx;
        })()
      );
      console.log(`✅ sent ${sol} SOL to landlord ${landlord.publicKey.toBase58()}`);
      console.log("  ", explorer(sig));
      break;
    }
    case "file-claim": {
      const claimSol = parseFloat(rest[0] ?? "0.05");
      const sig = await program.methods
        .fileClaim(new anchor.BN(Math.round(claimSol * LAMPORTS_PER_SOL)))
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
        .signers([landlord])
        .rpc();
      console.log(`✅ landlord filed claim for ${claimSol} SOL`);
      console.log("  ", explorer(sig));
      break;
    }
    case "accept": {
      const sig = await program.methods.acceptClaim().accounts(baseAccounts).rpc();
      console.log("✅ tenant accepted — deposit split, escrow settled");
      console.log("  ", explorer(sig));
      break;
    }
    case "dispute": {
      const sig = await program.methods
        .disputeClaim()
        .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, escrow })
        .rpc();
      console.log("✅ tenant disputed — funds frozen for off-chain arbitration");
      console.log("  ", explorer(sig));
      break;
    }
    case "timeout": {
      const sig = await program.methods.claimTimeout().accounts(baseAccounts).rpc();
      console.log("✅ claim timed out — settled to landlord");
      console.log("  ", explorer(sig));
      break;
    }
    case "release": {
      const sig = await program.methods.release().accounts(baseAccounts).rpc();
      console.log("✅ deposit released back to tenant");
      console.log("  ", explorer(sig));
      break;
    }
    case "show": {
      const acct = await (program.account as any).depositEscrow.fetch(escrow);
      const state = Object.keys(acct.state as object)[0];
      console.log("escrow:  ", escrow.toBase58());
      console.log("landlord:", (acct.landlord as PublicKey).toBase58());
      console.log("tenant:  ", (acct.tenant as PublicKey).toBase58());
      console.log("amount:  ", (acct.amount as anchor.BN).toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("state:   ", state);
      console.log("lease_end:", (acct.leaseEnd as anchor.BN).toString());
      console.log("claim_amount:", (acct.claimAmount as anchor.BN).toNumber() / LAMPORTS_PER_SOL, "SOL");
      console.log("claim_deadline:", (acct.claimDeadline as anchor.BN).toString());
      break;
    }
    default:
      console.log(
        "usage: yarn cli <init|fund-landlord|file-claim|accept|dispute|timeout|release|show> [args]"
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
