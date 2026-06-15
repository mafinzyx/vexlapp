import {
  Program,
  AnchorProvider,
  BN,
  web3,
} from "https://esm.sh/@coral-xyz/anchor@0.31.1";

const { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } = web3;

const ENDPOINT = "https://api.devnet.solana.com";
const connection = new Connection(ENDPOINT, "confirmed");
const enc = (s) => new TextEncoder().encode(s);

let IDL, PROGRAM_ID, wallet = null, loaded = null;

const $ = (id) => document.getElementById(id);
const log = (msg) => { $("log").textContent = msg; };
const txLink = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

function notice(html, ms = 0) {
  $("notice-text").innerHTML = html;
  $("notice").classList.add("show");
  if (ms) setTimeout(() => $("notice").classList.remove("show"), ms);
}

// A known, live devnet escrow for one-click inspection.
const DEMO = {
  landlord: "C8X8rngqPPE283w5AA9eUGHnCDaDmuDWs4kpZTrLLaii",
  tenant: "GuCk8T72uK2XmepqMW49ZciEtdkWRAchK7L6kiQ4U3FU",
};

async function boot() {
  IDL = await (await fetch("./idl.json")).json();
  PROGRAM_ID = new PublicKey(IDL.address);
  $("pid").textContent = IDL.address;
  $("pid-link").href = `https://explorer.solana.com/address/${IDL.address}?cluster=devnet`;
}

// A read-only provider needs *a* wallet with a publicKey; it is never used to sign reads.
function readonlyProvider() {
  const kp = Keypair.generate();
  const w = {
    publicKey: kp.publicKey,
    signTransaction: async () => { throw new Error("read only"); },
    signAllTransactions: async () => { throw new Error("read only"); },
  };
  return new AnchorProvider(connection, w, { commitment: "confirmed" });
}

function program(provider) {
  return new Program(IDL, provider);
}

function pdas(landlord, tenant) {
  const [escrow] = PublicKey.findProgramAddressSync(
    [enc("escrow"), landlord.toBytes(), tenant.toBytes()], PROGRAM_ID);
  const [vault] = PublicKey.findProgramAddressSync(
    [enc("vault"), escrow.toBytes()], PROGRAM_ID);
  return { escrow, vault };
}

// ---------- wallet ----------
$("connect").onclick = async () => {
  try {
    const provider = window.solana;
    if (!provider || !provider.isPhantom) {
      notice('Phantom not detected. <a href="https://phantom.app/" target="_blank">Install Phantom</a>, switch it to <b>Devnet</b>, then reload this page.');
      return;
    }
    const res = await provider.connect();
    wallet = {
      publicKey: res.publicKey,
      signTransaction: (tx) => provider.signTransaction(tx),
      signAllTransactions: (txs) => provider.signAllTransactions(txs),
    };
    const addr = res.publicKey.toBase58();
    $("wallet").textContent = addr.slice(0, 4) + "…" + addr.slice(-4);
    $("connect").textContent = "Connected";
    $("create").disabled = false;
    $("usemine").disabled = false;
    notice("Wallet connected ✓ Make sure Phantom is on <b>Devnet</b>.", 4000);
    log("Connected as " + addr + ". You are the tenant for new escrows.");
  } catch (e) {
    notice("Connection cancelled or failed: " + (e.message || e), 5000);
  }
};

// One-click: inspect a known live escrow.
$("demo").onclick = () => {
  $("i-landlord").value = DEMO.landlord;
  $("i-tenant").value = DEMO.tenant;
  loadState();
};

$("usemine").onclick = () => {
  if (wallet) $("i-tenant").value = wallet.publicKey.toBase58();
};

// ---------- create ----------
$("create").onclick = async () => {
  try {
    if (!wallet) return log("Connect Phantom first.");
    const landlord = new PublicKey($("c-landlord").value.trim());
    const tenant = wallet.publicKey;
    const amount = new BN(Math.round(parseFloat($("c-amount").value) * LAMPORTS_PER_SOL));
    const leaseEnd = new BN(Math.floor(Date.now() / 1000) + parseInt($("c-lease").value, 10) * 86400);
    const { escrow, vault } = pdas(landlord, tenant);
    const p = program(new AnchorProvider(connection, wallet, { commitment: "confirmed" }));
    log("Locking deposit… approve in Phantom.");
    const sig = await p.methods.initialize(amount, leaseEnd)
      .accounts({ tenant, landlord, escrow, vault, systemProgram: SystemProgram.programId })
      .rpc();
    log("✅ Deposit locked.\n" + txLink(sig));
    $("i-landlord").value = landlord.toBase58();
    $("i-tenant").value = tenant.toBase58();
    await loadState();
  } catch (e) { log("Error: " + (e.message || e)); }
};

// ---------- inspect ----------
$("load").onclick = () => loadState();

async function loadState() {
  try {
    const landlord = new PublicKey($("i-landlord").value.trim());
    const tenant = new PublicKey($("i-tenant").value.trim());
    const { escrow, vault } = pdas(landlord, tenant);
    const p = program(readonlyProvider());
    const acct = await p.account.depositEscrow.fetch(escrow);
    const vaultBal = (await connection.getBalance(vault)) / LAMPORTS_PER_SOL;
    loaded = { landlord, tenant, escrow, vault, acct };
    render(acct, escrow, vault, vaultBal);
    gateActions(acct);
  } catch (e) {
    $("state").innerHTML = `<div class="hint">No escrow found for that pair (or not yet created).</div>`;
    log("Error: " + (e.message || e));
  }
}

function stateName(s) { return Object.keys(s)[0]; }

function render(acct, escrow, vault, vaultBal) {
  const st = stateName(acct.state);
  const cls = "s-" + st.toLowerCase();
  const steps = ["Active", "ClaimFiled", "Settled/Released"];
  const reached = (name) => {
    if (name === "Active") return true;
    if (name === "ClaimFiled") return ["ClaimFiled", "Disputed", "Settled"].includes(st);
    return ["Settled", "Released"].includes(st);
  };
  const leaseDate = new Date(acct.leaseEnd.toNumber() * 1000).toISOString().slice(0, 16).replace("T", " ");
  $("state").innerHTML = `
    <div class="kv"><span class="k">State</span><span class="state ${cls}">${st}</span></div>
    <div class="kv"><span class="k">Deposit</span><span>${acct.amount.toNumber() / LAMPORTS_PER_SOL} SOL</span></div>
    <div class="kv"><span class="k">In vault now</span><span>${vaultBal} SOL</span></div>
    <div class="kv"><span class="k">Lease ends</span><span>${leaseDate} UTC</span></div>
    <div class="kv"><span class="k">Claim</span><span>${acct.claimAmount.toNumber() / LAMPORTS_PER_SOL} SOL</span></div>
    <div class="kv"><span class="k">Escrow PDA</span><span class="mono">${escrow.toBase58().slice(0, 8)}…</span></div>
    <div class="pipeline">${steps.map(s => `<span class="step-chip ${reached(s) ? "on" : ""}">${s}</span>`).join("")}</div>`;
}

// ---------- lifecycle ----------
function gateActions(acct) {
  const st = stateName(acct.state);
  const me = wallet ? wallet.publicKey.toBase58() : null;
  const isLandlord = me && me === loaded.landlord.toBase58();
  const isTenant = me && me === loaded.tenant.toBase58();
  const set = (act, on) => {
    const b = document.querySelector(`#lifecycle [data-act="${act}"]`);
    if (b) b.disabled = !on;
  };
  set("file_claim", st === "Active" && isLandlord);
  set("accept", st === "ClaimFiled" && isTenant);
  set("dispute", st === "ClaimFiled" && isTenant);
  set("timeout", st === "ClaimFiled" && !!wallet);
  set("release", st === "Active" && !!wallet);
  set("close", (st === "Settled" || st === "Released") && !!wallet);
  $("claim-hint").style.display = st === "Active" && isLandlord ? "block" : "none";
}

document.querySelectorAll("#lifecycle button").forEach((btn) => {
  btn.onclick = () => runAction(btn.dataset.act);
});

async function runAction(act) {
  try {
    if (!wallet) return log("Connect Phantom first.");
    if (!loaded) return log("Load an escrow first.");
    const { landlord, tenant, escrow, vault } = loaded;
    const p = program(new AnchorProvider(connection, wallet, { commitment: "confirmed" }));
    const sys = SystemProgram.programId;
    let sig;
    log("Sending… approve in Phantom.");
    if (act === "file_claim") {
      const amt = new BN(Math.round(parseFloat($("claim-amt").value) * LAMPORTS_PER_SOL));
      sig = await p.methods.fileClaim(amt).accounts({ landlord, tenant, escrow }).rpc();
    } else if (act === "accept") {
      sig = await p.methods.acceptClaim().accounts({ tenant, landlord, escrow, vault, systemProgram: sys }).rpc();
    } else if (act === "dispute") {
      sig = await p.methods.disputeClaim().accounts({ tenant, landlord, escrow }).rpc();
    } else if (act === "timeout") {
      sig = await p.methods.claimTimeout().accounts({ landlord, tenant, escrow, vault, systemProgram: sys }).rpc();
    } else if (act === "release") {
      sig = await p.methods.release().accounts({ tenant, landlord, escrow, vault, systemProgram: sys }).rpc();
    } else if (act === "close") {
      sig = await p.methods.closeEscrow().accounts({ tenant, landlord, escrow }).rpc();
    }
    log("✅ Done.\n" + txLink(sig));
    await loadState();
  } catch (e) { log("Error: " + (e.message || e)); }
}

boot();
