const vscode = acquireVsCodeApi();

let currentCurrency = 'CNY';
let isRefreshing = false;

function el(id) { return document.getElementById(id); }

var _debugLines = [];
function debugLog(msg) {
  console.log('[panel] ' + msg);
  _debugLines.push(new Date().toLocaleTimeString() + ' ' + msg);
  if (_debugLines.length > 20) { _debugLines.shift(); }
  var div = el('claudeDebug');
  if (div) {
    div.textContent = _debugLines.join('\n');
  }
}

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

function fmtNum(n) {
  if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
  if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'K'; }
  return n.toString();
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

function renderClaudeModule(data, scannedAt) {
  debugLog('renderClaudeModule called, tokens=' +
    (data.tokenStats ? data.tokenStats.inputTokens : 'N/A') +
    ' callCount=' + data.callCount);

  if (!el('claudeTokens')) {
    debugLog('ERROR: claudeTokens element not found in DOM!');
    return;
  }
  var totalTok = data.tokenStats.inputTokens + data.tokenStats.outputTokens + data.tokenStats.cacheReadTokens;
  el('claudeTokens').textContent = fmtNum(totalTok);
  el('claudeCalls').textContent = fmtNum(data.callCount);
  el('claudeCacheRate').textContent = (data.cacheHitRate * 100).toFixed(1) + '%';
  el('projectedCost').textContent = fmtNum(data.projectedMonthlyTokens || 0) + ' tokens';

  drawClaudeTrend(data.dailyStats);
  drawModelPie(data.modelUsage);
  renderTopProjects(data.topProjects || []);

  if (el('claudeUpdatedAt')) {
    var models = data.modelUsage.map(function(m) { return m.model; }).join(', ');
    el('claudeUpdatedAt').textContent = 'last scanned ' + formatUpdatedAt(scannedAt || Date.now()) +
      ' | ' + data.callCount + ' calls, models: ' + (models || 'none');
  }
}

function drawClaudeTrend(dailyStats) {
  var container = el('claudeChartContainer');
  var canvas = el('claudeTrendChart');
  if (!canvas || !container || dailyStats.length === 0) { return; }

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24;
  if (w < 80) { w = 80; }
  var h = 200;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var tokenValues = dailyStats.map(function (d) { return d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens; });
  var maxToken = Math.max.apply(null, tokenValues) || 1;

  var M = { top: 10, right: 16, bottom: 32, left: 50 };
  var plotW = w - M.left - M.right;
  var plotH = h - M.top - M.bottom;
  if (plotW < 20) { plotW = 20; }

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(128,128,128,0.12)';
  ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var yPos = M.top + plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(M.left, yPos);
    ctx.lineTo(w - M.right, yPos);
    ctx.stroke();
  }

  // Y axis (tokens)
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    var val = maxToken * (4 - i) / 4;
    var yPos = M.top + plotH * i / 4;
    ctx.fillText(fmtNum(val), M.left - 6, yPos);
  }

  // Draw bars
  var barCount = dailyStats.length;
  var slotW = plotW / barCount;
  var barW = Math.max(2, slotW * 0.5);

  for (var j = 0; j < barCount; j++) {
    var barH = plotH * tokenValues[j] / maxToken;
    var x = M.left + j * slotW + (slotW - barW) / 2;
    var y = M.top + plotH - barH;

    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(x, y, barW, barH);
  }

  // X labels — show every date, rotated if many
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';

  var labelStep = barCount <= 7 ? 1 : Math.ceil(barCount / 7);
  for (var j = 0; j < barCount; j += labelStep) {
    var label = dailyStats[j].date.slice(5); // MM-DD
    var x = M.left + j * slotW + slotW / 2;
    ctx.save();
    ctx.translate(x, M.top + plotH + 4);
    if (barCount > 7) {
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
    } else {
      ctx.textAlign = 'center';
    }
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

function drawModelPie(modelUsage) {
  var container = el('pieChartContainer');
  var canvas = el('modelPieChart');
  if (!canvas || !container || modelUsage.length === 0) { return; }
  if (container) { container.style.display = 'block'; }

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24;
  if (w < 80) { w = 80; }
  var h = 200;

  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var colors = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1'];
  // Compute total tokens per model for pie slices
  var modelTokens = modelUsage.map(function(m) { return m.inputTokens + m.outputTokens + m.cacheReadTokens; });
  var totalTokens = 0;
  for (var i = 0; i < modelTokens.length; i++) { totalTokens += modelTokens[i]; }
  if (totalTokens === 0) { return; }

  var cx = w * 0.35;
  var cy = h * 0.5;
  var radius = Math.min(cx - 10, cy - 10, 70);

  var startAngle = -Math.PI / 2;
  for (var i = 0; i < modelUsage.length; i++) {
    var sliceAngle = (modelTokens[i] / totalTokens) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
    ctx.lineWidth = 2;
    ctx.stroke();
    startAngle += sliceAngle;
  }

  // Legend
  var legendX = cx + radius + 16;
  var legendY = cy - (modelUsage.length * 18) / 2;
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  for (var i = 0; i < modelUsage.length; i++) {
    var y = legendY + i * 20;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(legendX, y - 5, 10, 10);
    ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
    ctx.textAlign = 'left';
    var pct = ((modelTokens[i] / totalTokens) * 100).toFixed(0);
    ctx.fillText(modelUsage[i].model + ' (' + pct + '%)', legendX + 14, y);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeProjectName(dir) {
  // Claude Code encodes project dirs as <drive><dashes><name>
  // e.g. "d----------chajian" → "chajian"
  var m = dir.match(/^[A-Za-z]-+(.+)$/);
  return m ? m[1] : dir;
}

function renderTopProjects(projects) {
  var list = el('topSessionsList');
  if (!list) { return; }
  var html = '';
  for (var i = 0; i < Math.min(projects.length, 5); i++) {
    var p = projects[i];
    var tokens = p.tokenStats.inputTokens + p.tokenStats.outputTokens + p.tokenStats.cacheReadTokens;
    var name = decodeProjectName(p.projectDir);
    html += '<div class="session-row">' +
      '<span>' + escapeHtml(name) + ' (' + p.callCount + ' calls)</span>' +
      '<span>' + fmtNum(tokens) + ' tok</span>' +
      '</div>';
  }
  list.innerHTML = html;
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
  } else if (msg.command === 'refreshHint') {
    var hint = document.getElementById('refreshHint');
    if (hint) {
      hint.textContent = msg.message;
      hint.classList.add('visible');
      setTimeout(function () { hint.classList.remove('visible'); }, 3000);
    }
  } else if (msg.command === 'claudeUpdate') {
    debugLog('claudeUpdate received: cost=' + msg.data.totalCost + ' calls=' + msg.data.callCount + ' models=' + msg.data.modelUsage.length + (msg.data.debugInfo ? ' | ' + msg.data.debugInfo : ''));
    renderClaudeModule(msg.data, msg.timestamp || Date.now());
  }
});

// Refresh button
el('refreshBtn').addEventListener('click', function () {
  vscode.postMessage({ command: 'refresh' });
});

// Signal ready
vscode.postMessage({ command: 'ready' });
