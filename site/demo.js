// Drives the live demo page: streams /api/demo/run and renders each event.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || "");
  const usdc = (v) => {
    const b = BigInt(v), base = 1000000n;
    const frac = (b % base).toString().padStart(6, "0").replace(/0+$/, "");
    return `${b / base}${frac ? "." + frac : ""} USDC`;
  };
  const eth = (wei) => (BigInt(wei) === 0n ? "0 ETH" : `${Number(BigInt(wei)) / 1e18} ETH`);

  let running = false;
  let ready = false;
  let funder = null;
  let payments = [];
  let started = 0;

  function setStatus(kind, text) {
    $("status").className = `pill ${kind}`;
    $("statusText").textContent = text;
  }

  function setButton() {
    const b = $("run");
    b.disabled = running || !ready;
    b.textContent = running ? "Running…" : ready ? (payments.length ? "Run again" : "Run live demo") : "Starting…";
  }

  async function poll() {
    try {
      const s = await (await fetch("/api/demo/status")).json();
      if (s.error) {
        ready = false;
        setStatus("warn", "demo unavailable");
        showError(`The demo could not start on this server: ${s.error}`);
      } else if (s.ready) {
        ready = true;
        if (!running) setStatus("ok", `ready · chain ${s.chainId} · ${s.runs} run${s.runs === 1 ? "" : "s"} so far`);
      } else {
        setStatus("warn", "starting the chain and contracts…");
        setTimeout(poll, 2000);
      }
    } catch {
      setStatus("warn", "offline, retrying…");
      setTimeout(poll, 3000);
    }
    setButton();
  }

  function step(n) {
    document.querySelectorAll("#steps li").forEach((li) => {
      const i = Number(li.dataset.n);
      li.className = i < n ? "done" : i === n ? "active" : "";
    });
  }

  function log(msg) {
    const el = $("log");
    el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function showError(msg) {
    const el = $("error");
    el.textContent = msg;
    el.classList.add("show");
  }

  function reset() {
    funder = null;
    payments = [];
    started = Date.now();
    step(0);
    $("result").className = "card result";
    $("error").className = "card error";
    $("funderAddr").textContent = "–";
    ["funderUsdc", "funderEth", "gasPaid"].forEach((id) => ($(id).textContent = "–"));
    $("shielded").textContent = "–";
    $("payments").innerHTML = '<div class="empty">Waiting for the agent…</div>';
    $("merchant").innerHTML = '<tr><td colspan="2" class="empty">–</td></tr>';
    $("audit").innerHTML = '<tr><td colspan="3" class="empty">–</td></tr>';
    $("verdict").innerHTML = "";
    $("auditTotals").textContent = "";
    $("screening").className = "empty";
    $("screening").textContent = "A sanctioned address will try to deposit at the end of the run.";
    $("log").textContent = "";
  }

  const handlers = {
    queued(e) {
      if (e.ahead > 0) setStatus("warn", `queued · ${e.ahead} run${e.ahead === 1 ? "" : "s"} ahead of you`);
    },
    step(e) {
      step(e.n);
      setStatus("ok", `step ${e.n} of 6 · ${e.title}`);
      log(`— ${e.title}`);
    },
    log(e) {
      log(e.msg);
    },
    chain(e) {
      log(`chain ${e.chainId} · pool ${e.pool} · USDC ${e.token}`);
    },
    funder(e) {
      funder = e.address;
      $("funderAddr").textContent = e.address;
      $("funderUsdc").textContent = usdc(e.usdc);
      $("funderEth").innerHTML = `<span class="zero">${eth(e.eth)}</span>`;
    },
    deposit(e) {
      $("gasPaid").innerHTML = `<span class="zero">${eth(e.ethSpent)}</span>`;
      $("funderUsdc").textContent = usdc(5000000n - BigInt(e.amount));
      $("shielded").textContent = usdc(e.shielded);
      $("shieldedSub").textContent = `Deposited ${usdc(e.amount)} with a signature only; the sponsor paid the gas.`;
    },
    payment(e) {
      if (!payments.length) $("payments").innerHTML = "";
      payments.push(e);
      const div = document.createElement("div");
      div.className = "pay";
      div.innerHTML = `
        <div class="pay-head"><b>GET ${esc(e.endpoint)}</b><span>HTTP ${e.status} · <span class="price">${usdc(e.price)}</span></span></div>
        <div class="sub" style="margin-top:6px">Paid by one-time account <span class="mono">${esc(e.payer)}</span></div>
        <pre>${esc(JSON.stringify(e.body, null, 2))}</pre>`;
      $("payments").appendChild(div);
      $("shielded").textContent = usdc(e.shielded);
    },
    merchant(e) {
      $("merchant").innerHTML = e.entries.length
        ? e.entries.map((x) => `<tr><td class="mono">${esc(short(x.payer))}</td><td>${usdc(x.amount)}</td></tr>`).join("")
        : '<tr><td colspan="2" class="empty">No payments</td></tr>';
    },
    payers(e) {
      const v = [];
      v.push(e.allDistinct ? '<span class="good">✓ every payment came from a different address</span>' : '<span class="bad">✗ payers repeated</span>');
      v.push(!e.linkedToFunder ? '<span class="good">✓ none of them is your public wallet</span>' : '<span class="bad">✗ linked to your wallet</span>');
      const fresh = e.payers.every((p) => p.txCount === 0 && BigInt(p.eth) === 0n);
      v.push(fresh ? '<span class="good">✓ payers never sent a transaction or held ETH</span>' : '<span class="bad">✗ payers have history</span>');
      $("verdict").innerHTML = v.join("");
    },
    audit(e) {
      $("audit").innerHTML = e.entries
        .map((x) => `<tr><td>${esc(x.kind)}</td><td>${usdc(x.amount)}</td><td class="mono">${esc(x.detail.replace(/0x[0-9a-fA-F]{40}/g, (a) => short(a)))}</td></tr>`)
        .join("");
      const t = e.totals;
      $("auditTotals").textContent = `Deposited ${usdc(t.deposited)} · paid ${usdc(t.paid)} · fees ${usdc(t.fees)} · balance ${usdc(t.shieldedBalance)}`;
    },
    screening(e) {
      const el = $("screening");
      el.className = "";
      el.innerHTML = e.rejected
        ? `<span class="good">✓ Rejected.</span> Screened address <span class="mono">${esc(short(e.blocked))}</span> tried to deposit: <span class="sub">${esc(e.reason)}</span>`
        : `<span class="bad">✗ ${esc(e.reason)}</span>`;
    },
    done(e) {
      step(7);
      const total = payments.reduce((s, p) => s + BigInt(p.price), 0n);
      const r = $("result");
      r.innerHTML = `
        <div class="big">✓ Done in ${(e.ms / 1000).toFixed(1)}s</div>
        <div class="sub">An AI agent paid ${payments.length} APIs (${usdc(total)}) from a shielded balance.</div>
        <ul>
          <li>${payments.length} payments, ${new Set(payments.map((p) => p.payer)).size} different one-time accounts</li>
          <li>The public wallet <span class="mono">${esc(short(funder))}</span> paid 0 ETH in gas and appears in none of the payments</li>
          <li>Each payment was funded by a Groth16 zero-knowledge proof</li>
        </ul>`;
      r.className = "card result show";
    },
    error(e) {
      showError(e.msg);
    },
  };

  async function run() {
    if (running) return;
    running = true;
    reset();
    setButton();
    setStatus("ok", "starting run…");
    try {
      const res = await fetch("/api/demo/run", { headers: { accept: "text/event-stream" } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          (handlers[e.t] || (() => {}))(e);
        }
      }
    } catch (err) {
      showError(err.message);
    } finally {
      running = false;
      await poll();
      setButton();
    }
  }

  $("run").addEventListener("click", run);
  poll();
})();
