/**
 * USDC-flow devnet demo — runs the full SPL-token escrow lifecycle on devnet
 * and prints Explorer links. The default Solana wallet is the TENANT; a landlord
 * keypair is generated at cli/landlord.json.
 *
 *   yarn ts-node cli/token-demo.ts
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
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import IDL from "../target/idl/deposit_escrow.json";

const PROGRAM_ID = new PublicKey(IDL.address);
const LANDLORD_PATH = path.join(__dirname, "landlord.json");
const UNIT = 1_000_000; // 6-decimal token (USDC-like)
const ex = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}
function loadOrCreateLandlord(): Keypair {
  if (fs.existsSync(LANDLORD_PATH)) return loadKeypair(LANDLORD_PATH);
  const kp = Keypair.generate();
  fs.writeFileSync(LANDLORD_PATH, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
  const tenant = loadKeypair(`${process.env.HOME}/.config/solana/id.json`);
  const landlord = loadOrCreateLandlord();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(tenant), {
    commitment: "confirmed",
  });
  const program = new Program(IDL as anchor.Idl, provider);

  // Fund the landlord for its file_claim fee.
  {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: tenant.publicKey,
        toPubkey: landlord.publicKey,
        lamports: 0.02 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  console.log("→ creating USDC-like mint (6 decimals)…");
  const mint = await createMint(connection, tenant, tenant.publicKey, null, 6);
  console.log("   mint:", mint.toBase58());

  const tenantAta = (await getOrCreateAssociatedTokenAccount(connection, tenant, mint, tenant.publicKey)).address;
  const landlordAta = (await getOrCreateAssociatedTokenAccount(connection, tenant, mint, landlord.publicKey)).address;
  await mintTo(connection, tenant, mint, tenantAta, tenant, 100 * UNIT);
  console.log("   minted 100 to tenant");

  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("tescrow"), landlord.publicKey.toBuffer(), tenant.publicKey.toBuffer(), mint.toBuffer()],
    PROGRAM_ID
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("tvault"), escrow.toBuffer()],
    PROGRAM_ID
  );

  const leaseEnd = Math.floor(Date.now() / 1000) + 6;
  let sig = await program.methods
    .initializeToken(new anchor.BN(50 * UNIT), new anchor.BN(leaseEnd))
    .accounts({
      tenant: tenant.publicKey,
      landlord: landlord.publicKey,
      mint,
      escrow,
      vault,
      tenantAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("✅ initialize_token: 50 USDC locked\n  ", ex(sig));

  await sleep(8000); // let the lease end

  sig = await program.methods
    .fileClaimToken(new anchor.BN(20 * UNIT))
    .accounts({ landlord: landlord.publicKey, tenant: tenant.publicKey, mint, escrow })
    .signers([landlord])
    .rpc();
  console.log("✅ file_claim_token: landlord claims 20 USDC\n  ", ex(sig));

  sig = await program.methods
    .acceptClaimToken()
    .accounts({
      tenant: tenant.publicKey,
      landlord: landlord.publicKey,
      mint,
      escrow,
      vault,
      landlordAta,
      tenantAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("✅ accept_claim_token: 20 → landlord, 30 → tenant\n  ", ex(sig));

  sig = await program.methods
    .closeToken()
    .accounts({ tenant: tenant.publicKey, landlord: landlord.publicKey, mint, escrow, vault, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  console.log("✅ close_token: vault + data account closed, rent reclaimed\n  ", ex(sig));

  console.log("\nmint:", mint.toBase58());
  console.log("escrow:", escrow.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
