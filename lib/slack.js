// Slack integration. Incoming webhook pattern — one URL, one POST.
//
// User generates the URL in Slack (Apps → Incoming Webhooks → Add to channel),
// pastes it in the Rates tab. The URL is a secret in the sense that anyone
// with it can post to that channel, so we store it in storage.local only.

async function postToSlack(webhookUrl, payload) {
  if (!webhookUrl || !/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
    throw new Error('Slack webhook URL missing or not a hooks.slack.com URL');
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

function formatPlanForSlack({ warehouse, hc, hoursLeft, shift, assignments, warnings, backlog, pickable }) {
  const lines = [];
  lines.push(`*HC Plan — ${warehouse} · ${shift} · ${hc} AAs · ${hoursLeft}h left*`);
  if (warnings && warnings.length) {
    lines.push('');
    lines.push('*Warnings*');
    for (const w of warnings) lines.push(`• ${w}`);
  }
  // Per-path summary, 2-col: path | (pickable units · rebin-ready carts · pack-ready carts)
  if (backlog || pickable) {
    lines.push('');
    lines.push('*Backlog*');
    lines.push('```');
    lines.push('Path              | Pickable | Rebin | Pack');
    for (const path of Object.keys(backlog || {})) {
      const b = backlog[path] || {};
      const cc = b.cartCounts || {};
      const p = pickable && pickable.totals && pickable.totals[path];
      lines.push(
        path.replace('PPFracs', '').padEnd(16) + ' | ' +
        String(p ?? 0).padStart(8) + ' | ' +
        String(cc.rebinReady ?? 0).padStart(5) + ' | ' +
        String(cc.packReady ?? 0).padStart(4)
      );
    }
    lines.push('```');
  }
  // Assignments
  if (assignments && assignments.length) {
    lines.push('');
    lines.push('*Assignments*');
    lines.push('```');
    lines.push('Login       | Path                 | Role   | Hours');
    for (const a of assignments) {
      lines.push(
        (a.login || '').padEnd(11) + ' | ' +
        (a.path || '—').padEnd(20) + ' | ' +
        (a.role || '').padEnd(6) + ' | ' +
        (a.hours || 0).toFixed(1)
      );
    }
    lines.push('```');
  }
  return { text: lines.join('\n') };
}

if (typeof self !== 'undefined') {
  self.Slack = { postToSlack, formatPlanForSlack };
}
