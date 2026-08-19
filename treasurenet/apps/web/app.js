/**
 * GM console logic. The GM keypair is generated in the browser
 * (WebCrypto Ed25519, exported raw) and held in localStorage — the Citizen
 * replacement for the Freighter wallet on the original Stellar console.
 * All hunt mutations are signed client-side; the server never sees keys.
 */

const API = "http://127.0.0.1:7755";
const logEl = document.getElementById("log");
const huntsEl = document.getElementById("hunts");
const didEl = document.getElementById("gm-did");

function log(message, ok = true) {
  const line = document.createElement("div");
  line.className = ok ? "ok" : "err";
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  logEl.prepend(line);
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? response.status);
  return json;
}

// ── Ed25519 key management (WebCrypto, raw 32-byte format) ──

const SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function unhex(value) {
  return new Uint8Array(value.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return {
    did: `did:key:ed25519:${hex(spki.slice(-32))}`,
    privateKeyHex: hex(pkcs8.slice(-32)),
  };
}

async function sign(message, privateKeyHex) {
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...unhex(privateKeyHex)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(null, new TextEncoder().encode(message), key);
  return hex(new Uint8Array(sig));
}

// ── GM identity ──

let gm = JSON.parse(localStorage.getItem("tn-gm") ?? "null");

async function ensureKey() {
  if (!gm) {
    gm = await generateKeyPair();
    localStorage.setItem("tn-gm", JSON.stringify(gm));
    log(`generated GM keypair ${gm.did.slice(0, 34)}…`);
  }
  didEl.textContent = gm.did;
}

document.getElementById("btn-new-key").onclick = async () => {
  gm = await generateKeyPair();
  localStorage.setItem("tn-gm", JSON.stringify(gm));
  didEl.textContent = gm.did;
  log("new GM keypair generated");
  refresh();
};

document.getElementById("btn-grant").onclick = async () => {
  try {
    await api("POST", "/wallet/register", { did: gm.did });
    await api("POST", "/roles/grant", { did: gm.did, role: "gamemaster" });
    log("gamemaster role granted (dev admin path)");
    refresh();
  } catch (error) {
    log(`role grant failed: ${error.message}`, false);
  }
};

// ── Hunt lifecycle buttons ──

const lifecycle = {
  fund: (hunt) => [
    "fund",
    `fund:${hunt.hunt_id}:${gm.did}`,
    { gm_signature: "", escrow_gm_signature: `fund:${hunt.escrow_id}` },
  ],
};

async function huntAction(hunt, action) {
  try {
    let body;
    if (action === "fund") {
      body = {
        gm_signature: await sign(`fund:${hunt.hunt_id}:${gm.did}`, gm.privateKeyHex),
        escrow_gm_signature: await sign(`fund:${hunt.escrow_id}`, gm.privateKeyHex),
      };
    } else {
      body = { gm_signature: await sign(`${action}:${hunt.hunt_id}:${gm.did}`, gm.privateKeyHex) };
    }
    await api("POST", `/games/${hunt.hunt_id}/${action}`, body);
    log(`${action} ok for ${hunt.hunt_id}`);
    refresh();
  } catch (error) {
    log(`${action} failed: ${error.message}`, false);
  }
}

document.getElementById("btn-create").onclick = async () => {
  try {
    const huntId = document.getElementById("f-hunt-id").value.trim() || `hunt-${Date.now().toString(36)}`;
    const expiresAt = new Date(Date.now() + Number(document.getElementById("f-hours").value) * 3600_000).toISOString();
    const gmSignature = await sign(`create:${huntId}:${gm.did}`, gm.privateKeyHex);
    const hunt = await api("POST", "/games", {
      hunt_id: huntId,
      gm_did: gm.did,
      gm_signature: gmSignature,
      title: document.getElementById("f-title").value,
      reward_amount: Number(document.getElementById("f-reward").value),
      expires_at: expiresAt,
      clues: [
        {
          index: 0,
          manifest_id: `manifest-${huntId}-0`,
          latitude: Number(document.getElementById("f-lat1").value),
          longitude: Number(document.getElementById("f-lon1").value),
          radius_meters: 50,
        },
        {
          index: 1,
          manifest_id: `manifest-${huntId}-1`,
          latitude: Number(document.getElementById("f-lat2").value),
          longitude: Number(document.getElementById("f-lon2").value),
          radius_meters: 50,
        },
      ],
    });
    log(`hunt created: ${hunt.hunt_id} (escrow ${hunt.escrow_id})`);
    refresh();
  } catch (error) {
    log(`create failed: ${error.message}`, false);
  }
};

async function refresh() {
  try {
    const hunts = await api("GET", "/games");
    huntsEl.innerHTML = "";
    if (hunts.length === 0) {
      huntsEl.textContent = "no hunts yet — create one on the left";
      return;
    }
    for (const hunt of hunts) {
      const card = document.createElement("div");
      card.className = "hunt";
      const actions = [];
      if (hunt.status === "created") actions.push("fund");
      if (hunt.status === "funded") actions.push("activate", "cancel");
      if (hunt.status === "active") actions.push("pause", "cancel");
      if (hunt.status === "paused") actions.push("resume");
      card.innerHTML = `
        <div class="title">${escapeHtml(hunt.title)}
          <span class="badge">${hunt.status}</span>
          <span class="badge">${hunt.reward_amount} ${hunt.reward_token}</span>
        </div>
        <div class="did">${hunt.hunt_id} · escrow ${hunt.escrow_id}</div>
        <div class="did">expires ${hunt.expires_at} · ${hunt.clues.length} clues</div>
        ${hunt.winner_did ? `<div class="did">winner ${hunt.winner_did}${hunt.receipt_id ? ` · receipt ${hunt.receipt_id}` : ""}</div>` : ""}
        <div class="row">${actions.map((a) => `<button class="secondary" data-action="${a}">${a}</button>`).join("")}</div>
      `;
      for (const button of card.querySelectorAll("button")) {
        button.onclick = () => huntAction(hunt, button.dataset.action);
      }
      huntsEl.appendChild(card);
    }
  } catch (error) {
    huntsEl.textContent = `failed to load hunts: ${error.message}`;
  }
}

// ── Pending player claim approvals (mobile app flow) ──

const pendingEl = document.getElementById("pending");

async function approveClaim(request) {
  try {
    const gmSignature = await sign(`claim:${request.hunt_id}:${request.player_did}`, gm.privateKeyHex);
    const escrowGmSignature = await sign(`claim:${request.escrow_id}:${request.player_did}`, gm.privateKeyHex);
    const claim = await api("POST", `/games/${request.hunt_id}/claim`, {
      request_id: request.request_id,
      gm_signature: gmSignature,
      escrow_gm_signature: escrowGmSignature,
    });
    log(`claim approved for ${request.player_did.slice(0, 30)}… receipt ${claim.receipt_id ?? "pending"}`);
    refreshPending();
    refresh();
  } catch (error) {
    log(`claim approval failed: ${error.message}`, false);
  }
}

async function refreshPending() {
  try {
    const pending = await api("GET", "/claims/pending");
    pendingEl.innerHTML = "";
    if (pending.length === 0) {
      pendingEl.textContent = "none";
      return;
    }
    for (const request of pending) {
      const card = document.createElement("div");
      card.className = "hunt";
      card.innerHTML = `
        <div class="title">Claim request
          <span class="badge">${escapeHtml(request.hunt_id)}</span>
          <span class="badge">${new Date(request.created_at).toLocaleTimeString()}</span>
        </div>
        <div class="did">player ${escapeHtml(request.player_did)}</div>
        <div class="did">photo proof attached · ${request.photo_b64.length} bytes base64</div>
        <div class="row">
          <button data-approve="1">Approve + sign payout</button>
          <button class="secondary" data-deny="1">Deny</button>
        </div>
      `;
      card.querySelector("[data-approve]").onclick = () => approveClaim(request);
      card.querySelector("[data-deny]").onclick = async () => {
        try {
          await api("POST", `/claims/${request.request_id}/deny`);
          log("claim request denied");
        } catch (error) {
          log(`deny failed: ${error.message}`, false);
        }
        refreshPending();
      };
      pendingEl.appendChild(card);
    }
  } catch (error) {
    pendingEl.textContent = `failed to load pending claims: ${error.message}`;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

await ensureKey();
refresh();
refreshPending();
setInterval(refresh, 10_000);
setInterval(refreshPending, 5_000);
