const vscode = acquireVsCodeApi();

let currentCurrency = 'CNY';
let isRefreshing = false;

function el(id) { return document.getElementById(id); }

function formatCurrency(val, currency) {
  const num = parseFloat(val);
  if (isNaN(num)) { return '--'; }
  return currency === 'USD' ? '$' + num.toFixed(2) : '¥' + num.toFixed(2);
}

function formatUpdatedAt(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) { return 'updated just now'; }
  if (diffMin < 60) { return 'updated ' + diffMin + 'm ago'; }
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) { return 'updated ' + hours + 'h ago'; }
  return 'updated ' + d.toLocaleDateString();
}

function updateUI(data) {
  const balance = data.balance;
  const snapshots = data.snapshots;
  const stats = data.stats;

  if (balance) {
    el('error').style.display = 'none';
    el('chartContainer').style.display = 'block';
    el('stats').style.display = '';

    currentCurrency = balance.currency || 'CNY';

    const num = parseFloat(balance.total);
    const cls = num <= 2 ? 'danger' : num <= 10 ? 'warning' : '';
    el('balanceTotal').textContent = formatCurrency(balance.total, currentCurrency);
    el('balanceTotal').className = 'balance-value ' + cls;
    el('toppedUp').textContent = formatCurrency(balance.toppedUp, currentCurrency);
    el('granted').textContent = formatCurrency(balance.granted, currentCurrency);
  }

  if (stats) {
    const sign = currentCurrency === 'USD' ? '$' : '¥';
    el('stat1h').textContent = sign + stats.last1h.toFixed(3);
    el('stat24h').textContent = sign + stats.last24h.toFixed(2);
    el('stat7d').textContent = sign + stats.last7d.toFixed(2);
    el('statTotal').textContent = sign + stats.totalConsumed.toFixed(2);
  }

  if (snapshots && snapshots.length > 0) {
    el('updatedAt').textContent = formatUpdatedAt(snapshots[snapshots.length - 1].timestamp);
    drawChart(snapshots);
  }
}

function showError(message) {
  el('error').style.display = 'block';
  el('error').textContent = '⚠ ' + message;
  el('chartContainer').style.display = 'none';
  el('stats').style.display = 'none';
}

// ---- Manual canvas line chart ----
function drawChart(snapshots) {
  const container = el('chartContainer');
  const canvas = el('chart');
  if (!canvas || !container) { return; }

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  let w = rect.width - 24; // padding compensation
  if (w < 80) { w = 80; }
  const h = 180;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const values = snapshots.map(function (s) { return parseFloat(s.totalBalance); });
  let minVal = Math.min.apply(null, values);
  let maxVal = Math.max.apply(null, values);
  let range = maxVal - minVal;
  if (range < 0.01) { range = 1; }
  const pad = range * 0.2;
  const yMin = Math.max(0, minVal - pad);
  const yMax = maxVal + pad;

  const M = { top: 10, right: 16, bottom: 24, left: 60 };
  let plotW = w - M.left - M.right;
  let plotH = h - M.top - M.bottom;
  if (plotW < 20) { plotW = 20; }

  ctx.clearRect(0, 0, w, h);

  // Y-axis grid + labels
  ctx.textBaseline = 'middle';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.lineWidth = 1;

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const yVal = yMin + (yMax - yMin) * (i / ySteps);
    const yPos = M.top + plotH - plotH * (i / ySteps);
    ctx.textAlign = 'right';
    ctx.fillText(formatCurrency(yVal, currentCurrency), M.left - 6, yPos);
    ctx.beginPath();
    ctx.moveTo(M.left, yPos);
    ctx.lineTo(w - M.right, yPos);
    ctx.stroke();
  }

  // X-axis labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const maxLabels = Math.min(snapshots.length, 6);
  const labelStep = Math.max(1, Math.ceil(snapshots.length / maxLabels));
  for (let j = 0; j < snapshots.length; j += labelStep) {
    const d = new Date(snapshots[j].timestamp);
    const label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
    const x = M.left + plotW * j / Math.max(1, snapshots.length - 1);
    ctx.fillText(label, x, M.top + plotH + 6);
  }

  function xPos(i) { return M.left + plotW * i / Math.max(1, snapshots.length - 1); }
  function yPos(i) { return M.top + plotH - plotH * (values[i] - yMin) / (yMax - yMin); }

  // Fill
  ctx.beginPath();
  ctx.moveTo(xPos(0), M.top + plotH);
  for (let k = 0; k < snapshots.length; k++) {
    ctx.lineTo(xPos(k), yPos(k));
  }
  ctx.lineTo(xPos(snapshots.length - 1), M.top + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(79, 195, 247, 0.08)';
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.moveTo(xPos(0), yPos(0));
  for (let m = 1; m < snapshots.length; m++) {
    ctx.lineTo(xPos(m), yPos(m));
  }
  ctx.stroke();

  // Points
  for (let p = 0; p < snapshots.length; p++) {
    ctx.beginPath();
    ctx.arc(xPos(p), yPos(p), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4fc3f7';
    ctx.fill();
  }
}

// ---- Messages ----
window.addEventListener('message', function (event) {
  const msg = event.data;
  if (msg.command === 'update') {
    updateUI(msg);
  } else if (msg.command === 'error') {
    showError(msg.message);
  } else if (msg.command === 'refreshing') {
    isRefreshing = msg.active;
    const btn = el('refreshBtn');
    if (btn) {
      btn.textContent = isRefreshing ? '⟳ Refreshing...' : '⟳ Refresh';
      btn.disabled = isRefreshing;
      btn.style.opacity = isRefreshing ? '0.6' : '1';
    }
  }
});

// Refresh button
el('refreshBtn').addEventListener('click', function () {
  vscode.postMessage({ command: 'refresh' });
});

// Signal ready
vscode.postMessage({ command: 'ready' });
