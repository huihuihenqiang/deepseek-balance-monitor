const vscode = acquireVsCodeApi();

var currentCurrency = 'CNY';
var isRefreshing = false;
var lowBalanceThreshold = 5;
var lowDaysThreshold = 5;
var currentClaudeTab = 'today';
var lastClaudeData = null;
var TREND_POINT_LIMIT = 12;
var MIN_PROJECTION_DAY_FRACTION = 0.25;

function el(id) { return document.getElementById(id); }

function formatCurrency(val, currency) {
  var num = parseFloat(val);
  if (isNaN(num)) { return '--'; }
  return currency === 'USD' ? '$' + num.toFixed(2) : 'CNY ' + num.toFixed(2);
}

function formatUpdatedAt(ts) {
  var d = new Date(ts);
  var diffMin = Math.floor((Date.now() - d) / 60000);
  if (diffMin < 1) { return 'updated just now'; }
  if (diffMin < 60) { return 'updated ' + diffMin + 'm ago'; }
  var hours = Math.floor(diffMin / 60);
  if (hours < 24) { return 'updated ' + hours + 'h ago'; }
  return 'updated ' + d.toLocaleDateString();
}

function fmtNum(n) {
  if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
  if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'K'; }
  return Math.round(n).toString();
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeProjectName(dir) {
  var m = dir.match(/^[A-Za-z]-+(.+)$/);
  return m ? m[1] : dir;
}

function showTooltip(id, e, text) {
  var tip = el(id);
  if (!tip) { return; }
  tip.textContent = text;
  tip.style.display = 'block';
  var cr = tip.parentElement.getBoundingClientRect();
  var x = e.clientX - cr.left + 12;
  var y = e.clientY - cr.top - 28;
  if (x + 150 > cr.width) { x = e.clientX - cr.left - 160; }
  if (y < 0) { y = e.clientY - cr.top + 12; }
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideTooltip(id) {
  var tip = el(id);
  if (tip) { tip.style.display = 'none'; }
}

function updatePetStatus(status) {
  var btn = el('petBtn');
  var label = el('petBtnLabel');
  if (!btn || !label || !status) { return; }
  var visualStatus = status.status === 'starting' ? 'running' : status.status;
  btn.className = 'refresh-btn pet-btn ' + visualStatus;
  if (status.status === 'running' || status.status === 'starting') {
    label.textContent = 'Pet On';
  } else if (status.status === 'error') {
    label.textContent = 'Pet Err';
  } else {
    label.textContent = 'Pet';
  }
  btn.title = status.message || 'Toggle floating token pet';
}

// ==============================
//  DEEPSEEK BALANCE
// ==============================

function updateUI(data) {
  var balance = data.balance;
  var snapshots = data.snapshots;
  var stats = data.stats;

  if (balance) {
    el('error').style.display = 'none';
    el('chartContainer').style.display = 'block';
    el('stats').style.display = '';

    currentCurrency = balance.currency || 'CNY';
    var num = parseFloat(balance.total);
    var cls = num <= lowBalanceThreshold ? 'danger' : num <= lowBalanceThreshold * 2 ? 'warning' : '';
    el('balanceTotal').textContent = formatCurrency(balance.total, currentCurrency);
    el('balanceTotal').className = 'balance-value ' + cls;

    if (stats) {
      el('totalConsumed').textContent = formatCurrency(stats.totalConsumed, currentCurrency);
    }
    updateDaysRemaining(balance.total, stats);
  }

  if (stats) {
    var sign = currentCurrency === 'USD' ? '$' : 'CNY ';
    el('stat1h').textContent = sign + stats.last1h.toFixed(3);
    el('stat24h').textContent = sign + stats.last24h.toFixed(2);
    el('stat7d').textContent = sign + stats.last7d.toFixed(2);
  }

  if (snapshots && snapshots.length > 0) {
    el('updatedAt').textContent = formatUpdatedAt(snapshots[snapshots.length - 1].timestamp);
    drawChart(snapshots);
  }
}

function updateDaysRemaining(balanceVal, stats) {
  var div = el('daysRemaining');
  if (!div) { return; }
  if (!stats || stats.last7d <= 0 || !balanceVal) {
    div.textContent = '--';
    div.style.color = '';
    return;
  }
  var dailyAvg = stats.last7d / 7;
  if (dailyAvg <= 0) { div.textContent = '--'; div.style.color = ''; return; }
  var days = parseFloat(balanceVal) / dailyAvg;
  if (days > 365) {
    div.textContent = Math.round(days / 30) + 'mo';
  } else {
    div.textContent = Math.round(days) + 'd';
  }
  if (days < lowDaysThreshold) {
    div.style.color = 'var(--vscode-errorForeground)';
  } else if (days < lowDaysThreshold * 2) {
    div.style.color = 'var(--vscode-editorWarning-foreground)';
  } else {
    div.style.color = '';
  }
}

function showError(message) {
  el('error').style.display = 'block';
  el('error').textContent = 'Error: ' + message;
  el('chartContainer').style.display = 'none';
  el('stats').style.display = 'none';
}

function drawChart(snapshots) {
  var container = el('chartContainer');
  var canvas = el('chart');
  if (!canvas || !container) { return; }
  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = 180;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  var values = snapshots.map(function(s) { return parseFloat(s.totalBalance); });
  var minVal = Math.min.apply(null, values);
  var maxVal = Math.max.apply(null, values);
  var range = maxVal - minVal; if (range < 0.01) { range = 1; }
  var pad = range * 0.2;
  var yMin = Math.max(0, minVal - pad);
  var yMax = maxVal + pad;
  var M = { top: 10, right: 16, bottom: 24, left: 60 };
  var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
  var plotH = h - M.top - M.bottom;

  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.strokeStyle = 'rgba(128,128,128,0.15)';
  ctx.lineWidth = 1;

  for (var i = 0; i <= 4; i++) {
    var yVal = yMin + (yMax - yMin) * (i / 4);
    var yp = M.top + plotH - plotH * (i / 4);
    ctx.textAlign = 'right';
    ctx.fillText(formatCurrency(yVal, currentCurrency), M.left - 6, yp);
    ctx.beginPath(); ctx.moveTo(M.left, yp); ctx.lineTo(w - M.right, yp); ctx.stroke();
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var maxLabels = Math.min(snapshots.length, 6);
  var labelStep = Math.max(1, Math.ceil(snapshots.length / maxLabels));
  for (var j = 0; j < snapshots.length; j += labelStep) {
    var d = new Date(snapshots[j].timestamp);
    var label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    ctx.fillText(label, M.left + plotW * j / Math.max(1, snapshots.length - 1), M.top + plotH + 6);
  }

  function xPos(i) { return M.left + plotW * i / Math.max(1, snapshots.length - 1); }
  function yPos(i) { return M.top + plotH - plotH * (values[i] - yMin) / (yMax - yMin); }

  ctx.beginPath(); ctx.moveTo(xPos(0), M.top + plotH);
  for (var k = 0; k < snapshots.length; k++) { ctx.lineTo(xPos(k), yPos(k)); }
  ctx.lineTo(xPos(snapshots.length - 1), M.top + plotH); ctx.closePath();
  ctx.fillStyle = 'rgba(79, 195, 247, 0.08)'; ctx.fill();

  ctx.beginPath(); ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.moveTo(xPos(0), yPos(0));
  for (var m = 1; m < snapshots.length; m++) { ctx.lineTo(xPos(m), yPos(m)); }
  ctx.stroke();

  for (var p = 0; p < snapshots.length; p++) {
    ctx.beginPath(); ctx.arc(xPos(p), yPos(p), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4fc3f7'; ctx.fill();
  }

  canvas.onmousemove = function(e) {
    var cr = canvas.getBoundingClientRect(), mx = e.clientX - cr.left;
    var closest = 0, minDist = Infinity;
    for (var i = 0; i < snapshots.length; i++) { var dist = Math.abs(xPos(i) - mx); if (dist < minDist) { minDist = dist; closest = i; } }
    var s = snapshots[closest]; var d2 = new Date(s.timestamp);
    var label2 = (d2.getMonth() + 1) + '/' + d2.getDate() + ' ' + String(d2.getHours()).padStart(2, '0') + ':' + String(d2.getMinutes()).padStart(2, '0');
    showTooltip('chartTooltip', e, label2 + '  ' + formatCurrency(s.totalBalance, currentCurrency));
    drawChart(snapshots);
    ctx.beginPath(); ctx.arc(xPos(closest), yPos(closest), 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(79, 195, 247, 0.3)'; ctx.fill();
    ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.stroke();
  };
  canvas.onmouseleave = function() { hideTooltip('chartTooltip'); drawChart(snapshots); };
}

// ==============================
//  CLAUDE CODE USAGE
// ==============================

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function todayStr() { return dateKey(new Date()); }
function currentYearMonth() { return todayStr().slice(0, 7); }
function tokenTotal(d) { return d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens; }

function dayProgress(now) {
  var mins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return Math.max(0, Math.min(1, mins / 1440));
}

function elapsedCurrentWeekDays(now) {
  var day = now.getDay();
  var daysBeforeToday = day === 0 ? 6 : day - 1;
  return daysBeforeToday + Math.max(dayProgress(now), MIN_PROJECTION_DAY_FRACTION);
}

function elapsedCurrentMonthDays(now) {
  return (now.getDate() - 1) + Math.max(dayProgress(now), MIN_PROJECTION_DAY_FRACTION);
}

function recentItems(items, limit) {
  var list = items || [];
  return list.slice(Math.max(0, list.length - limit));
}

function getWeekRange(offset) {
  var now = new Date();
  var day = now.getDay();
  var mondayOffset = day === 0 ? -6 : 1 - day;
  var shift = (offset || 0) * 7;
  var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + shift);
  var sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: dateKey(monday), end: dateKey(sunday) };
}

function addDaysToKey(key, days) {
  var d = new Date(key + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

function getWeekToDateRange(offset) {
  var range = getWeekRange(offset);
  var elapsedDays = Math.max(1, Math.min(7, Math.ceil(elapsedCurrentWeekDays(new Date()))));
  return { start: range.start, end: addDaysToKey(range.start, elapsedDays - 1) };
}

function daysInMonth() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate(); }
function dayOfMonth() { return new Date().getDate(); }

function getDayName(d) {
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[new Date(d + 'T00:00:00').getDay()];
}

// ---- Tab data ----
function filterAndAggregate(data) {
  var ds = data.dailyStats || [];
  var today = todayStr();
  var ym = currentYearMonth();
  var thisWeek = getWeekRange(0);

  var filtered, tabLabel;
  if (currentClaudeTab === 'today') {
    filtered = ds.filter(function(d) { return d.date === today; });
    tabLabel = 'today';
  } else if (currentClaudeTab === 'week') {
    filtered = ds.filter(function(d) { return d.date >= thisWeek.start && d.date <= thisWeek.end; });
    tabLabel = 'week';
  } else if (currentClaudeTab === 'month') {
    filtered = ds.filter(function(d) { return d.date.startsWith(ym); });
    tabLabel = 'month';
  } else {
    filtered = ds;
    tabLabel = 'cumulative';
  }

  var totalTok = 0, totalCost = 0, calls = 0, inTok = 0, cacheRead = 0;
  for (var i = 0; i < filtered.length; i++) {
    var s = filtered[i];
    totalTok += tokenTotal(s);
    totalCost += s.cost || 0;
    calls += s.callCount || 0;
    inTok += s.tokenStats.inputTokens;
    cacheRead += s.tokenStats.cacheReadTokens;
  }
  var totalInput = inTok + cacheRead;
  var cacheRate = totalInput > 0 ? cacheRead / totalInput : 0;

  return {
    dailyStats: filtered,
    totalTokens: totalTok,
    totalCost: totalCost,
    callCount: calls,
    cacheHitRate: cacheRate,
    label: tabLabel
  };
}

function computeProjection(totalSoFar, daysElapsed, daysInPeriod) {
  if (totalSoFar <= 0 || daysInPeriod <= 0 || daysElapsed <= 0) { return 0; }
  var elapsed = Math.min(Math.max(daysElapsed, MIN_PROJECTION_DAY_FRACTION), daysInPeriod);
  if (elapsed >= daysInPeriod) { return totalSoFar; }
  return (totalSoFar / elapsed) * daysInPeriod;
}

// ---- Main render ----
function renderClaudeModule(data, scannedAt) {
  if (!el('claudeTokens')) { return; }
  lastClaudeData = data;
  el('claudeEmptyHint').style.display = 'none';
  el('claudeDataSection').style.display = '';

  var f = filterAndAggregate(data);

  el('claudeTokens').textContent = fmtNum(f.totalTokens);
  el('claudeCalls').textContent = fmtNum(f.callCount);
  el('claudeCacheRate').textContent = (f.cacheHitRate * 100).toFixed(1) + '%';

  drawClaudeChart(data, f);

  // Pie chart: only on cumulative tab
  var pieContainer = el('pieChartContainer');
  if (currentClaudeTab === 'cumulative') {
    if (pieContainer) { pieContainer.style.display = 'block'; }
    drawModelPie(data.modelUsage);
  } else {
    if (pieContainer) { pieContainer.style.display = 'none'; }
  }

  // Project ranking only on Cumulative tab
  if (currentClaudeTab === 'cumulative') {
    el('topSessionsContainer').style.display = '';
    renderProjectRanking(data.topProjects || [], data);
  } else {
    el('topSessionsContainer').style.display = 'none';
  }

  // Tab-specific extra content
  buildTabExtra(data, f);

}

function drawClaudeChart(data, f) {
  // Hide tab-specific sub-charts from other tabs
  var cumulDiv = el('monthCumulSection');
  if (cumulDiv && currentClaudeTab !== 'month') { cumulDiv.style.display = 'none'; }
  var cacheDiv = el('cacheTrendSection');
  if (cacheDiv && currentClaudeTab !== 'cumulative') { cacheDiv.style.display = 'none'; }
  var callsCanvas = el('todayCallsCanvas');
  if (callsCanvas) { callsCanvas.style.display = currentClaudeTab === 'today' ? '' : 'none'; }
  var callsTitle = el('todayCallsTitle');
  if (callsTitle) { callsTitle.style.display = currentClaudeTab === 'today' ? '' : 'none'; }

  if (currentClaudeTab === 'today') { drawTodayChart(data); }
  else if (currentClaudeTab === 'week') { /* chart drawn after table in buildTabExtra */ }
  else if (currentClaudeTab === 'month') { drawMonthChart(data, f); }
  else { drawCumulativeChart(data); }
}

// ================ TODAY: hourly bars + yesterday same-hour line + call count chart ================
function drawTodayChart(data) {
  var container = el('claudeChartContainer');
  var canvas = el('claudeTrendChart');
  if (!canvas || !container) { return; }

  var hourly = data.todayHourly || [];
  var yesterday = data.yesterdayHourly || [];
  var nowHour = new Date().getHours();

  // ---- Chart 1: Token Usage ----
  el('claudeChartTitle').textContent = 'Token Usage (Today, by hour)';
  drawHourlyBars(canvas, container, hourly, yesterday, nowHour, 'tokens');

  // ---- Chart 2: Call Count ----
  var callsCanvas = el('todayCallsCanvas');
  if (!callsCanvas) {
    callsCanvas = document.createElement('canvas');
    callsCanvas.id = 'todayCallsCanvas';
    callsCanvas.style.width = '100%';
    callsCanvas.style.height = '160px';
    container.appendChild(callsCanvas);
    // Add title
    var callsTitle = document.createElement('div');
    callsTitle.className = 'chart-title';
    callsTitle.id = 'todayCallsTitle';
    callsTitle.textContent = 'Call Count (Today, by hour)';
    callsTitle.style.marginTop = '12px';
    container.insertBefore(callsTitle, callsCanvas);
  }
  el('todayCallsTitle').style.display = '';
  callsCanvas.style.display = '';
  drawHourlyBars(callsCanvas, container, hourly, yesterday, nowHour, 'calls');

  // No projection for today
  el('costProjection').style.display = 'none';
  el('dayComparison').innerHTML = '';
}

function drawHourlyBars(canvas, container, hourly, yesterday, nowHour, mode) {
  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = mode === 'tokens' ? 160 : 130;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  function hourlyValues(items) {
    var out = [];
    for (var h = 0; h < 24; h++) { out.push(0); }
    for (var i = 0; i < (items || []).length; i++) {
      var item = items[i] || {};
      var hour = typeof item.hour === 'number' ? item.hour : i;
      if (hour < 0 || hour >= 24) { continue; }
      out[hour] = mode === 'tokens' ? (item.tokens || 0) : (item.calls || 0);
    }
    return out;
  }

  var values = hourlyValues(hourly);
  var yesterdayVals = hourlyValues(yesterday);
  var maxVal = Math.max.apply(null, values.concat(yesterdayVals).concat([1]));

  var M = { top: 10, right: 16, bottom: 22, left: 40 };
  var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
  var plotH = h - M.top - M.bottom;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var gY = M.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(M.left, gY); ctx.lineTo(w - M.right, gY); ctx.stroke();
  }

  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    ctx.fillText(fmtNum(maxVal * (4 - i) / 4), M.left - 4, M.top + plotH * i / 4);
  }

  var barCount = 24, slotW = plotW / barCount, barW = Math.max(1, slotW * 0.6);

  // Bars
  for (var j = 0; j < barCount; j++) {
    var barH = plotH * values[j] / maxVal;
    var x = M.left + j * slotW + (slotW - barW) / 2;
    var y = M.top + plotH - barH;
    ctx.fillStyle = j === nowHour ? '#ffb74d' : '#4fc3f7';
    ctx.fillRect(x, y, barW, barH);
  }

  // Yesterday same-hour line (solid, orange, with dots)
  function cx(i) { return M.left + slotW * i + slotW / 2; }
  function yy(i) { return M.top + plotH - plotH * yesterdayVals[i] / maxVal; }

  var hasYest = false;
  for (var k = 0; k < 24; k++) { if (yesterdayVals[k] > 0) { hasYest = true; break; } }
  if (hasYest) {
    // Subtle fill
    ctx.beginPath();
    ctx.moveTo(cx(0), M.top + plotH);
    for (var m = 0; m < barCount; m++) { ctx.lineTo(cx(m), yy(m)); }
    ctx.lineTo(cx(barCount - 1), M.top + plotH); ctx.closePath();
    ctx.fillStyle = 'rgba(129,199,132,0.05)'; ctx.fill();

    // Solid line
    ctx.beginPath();
    ctx.strokeStyle = '#81c784'; ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.moveTo(cx(0), yy(0));
    for (var m = 1; m < barCount; m++) { ctx.lineTo(cx(m), yy(m)); }
    ctx.stroke();

    // Dots
    for (var p = 0; p < barCount; p++) {
      ctx.beginPath(); ctx.arc(cx(p), yy(p), yesterdayVals[p] > 0 ? 2.5 : 1.6, 0, Math.PI * 2);
      ctx.fillStyle = yesterdayVals[p] > 0 ? '#81c784' : 'rgba(129,199,132,0.55)';
      ctx.fill();
    }
    ctx.font = '9px sans-serif'; ctx.fillStyle = '#81c784'; ctx.textAlign = 'left';
    ctx.fillText('yesterday', cx(23) - 50, yy(23) - 4);
  }

  // X labels
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (var j = 0; j < barCount; j += 3) {
    ctx.fillText(String(j).padStart(2, '0') + ':00', cx(j), M.top + plotH + 3);
  }

  var tooltipId = (canvas.id === 'claudeTrendChart') ? 'claudeChartTooltip' : 'callsTooltip';
  // Hover
  canvas.onmousemove = function(e) {
    var cr = canvas.getBoundingClientRect(), mx = e.clientX - cr.left;
    var idx = Math.floor((mx - M.left) / (slotW || 1));
    if (idx < 0 || idx >= barCount) { hideTooltip(tooltipId); drawHourlyBars(canvas, container, hourly, yesterday, nowHour, mode); return; }
    var unit = mode === 'tokens' ? ' tok' : ' calls';
    var yVal = idx < yesterdayVals.length ? (' | yest ' + fmtNum(yesterdayVals[idx]) + unit) : '';
    showTooltip(tooltipId, e, String(idx).padStart(2, '0') + ':00  ' + fmtNum(values[idx]) + unit + yVal);
    drawHourlyBars(canvas, container, hourly, yesterday, nowHour, mode);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(M.left + idx * slotW + (slotW - barW) / 2, M.top, barW, plotH);
  };
  canvas.onmouseleave = function() { hideTooltip(tooltipId); drawHourlyBars(canvas, container, hourly, yesterday, nowHour, mode); };

  // Add tooltip div for calls chart if needed
  if (canvas.id === 'todayCallsCanvas' && !el('callsTooltip')) {
    var tipDiv = document.createElement('div');
    tipDiv.id = 'callsTooltip';
    tipDiv.className = 'chart-tooltip';
    container.appendChild(tipDiv);
  }
}

// ================ WEEK: bar chart Mon-Sun + last week line ================
function drawWeekChart(data) {
  var container = el('claudeChartContainer');
  var canvas = el('claudeTrendChart');
  if (!canvas || !container) { return; }
  el('claudeChartTitle').textContent = 'Token Usage (This Week)';

  var ds = data.dailyStats || [];
  var now = new Date();
  var mondayOffset = now.getDay() === 0 ? -6 : 1 - now.getDay();

  var dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var thisWeekVals = [];
  var lastWeekVals = [];

  for (var i = 0; i < 7; i++) {
    // This week
    var dayOffset = mondayOffset + i;
    var tw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    var dateStr = dateKey(tw);
    var found = ds.filter(function(x) { return x.date === dateStr; });
    var tok = 0;
    for (var fi = 0; fi < found.length; fi++) {
      tok += tokenTotal(found[fi]);
    }
    thisWeekVals.push(tok);

    // Last week
    var lw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset - 7);
    var ldateStr = dateKey(lw);
    var lfound = ds.filter(function(x) { return x.date === ldateStr; });
    var ltok = 0;
    for (var lfi = 0; lfi < lfound.length; lfi++) {
      ltok += tokenTotal(lfound[lfi]);
    }
    lastWeekVals.push(ltok);
  }

  var maxT = Math.max.apply(null, thisWeekVals.concat(lastWeekVals).concat([1]));

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  var M = { top: 10, right: 16, bottom: 30, left: 50 };
  var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
  var plotH = h - M.top - M.bottom;

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var gY = M.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(M.left, gY); ctx.lineTo(w - M.right, gY); ctx.stroke();
  }

  // Y axis
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    ctx.fillText(fmtNum(maxT * (4 - i) / 4), M.left - 6, M.top + plotH * i / 4);
  }

  // Bars for this week
  var barCount = 7, slotW = plotW / barCount, barW2 = Math.max(6, slotW * 0.4);

  for (var j = 0; j < barCount; j++) {
    var barH = plotH * thisWeekVals[j] / maxT;
    var x = M.left + j * slotW + (slotW - barW2) / 2;
    var y = M.top + plotH - barH;
    // Highlight today
    var todayIdx = now.getDay();
    todayIdx = todayIdx === 0 ? 6 : todayIdx - 1; // Mon=0,...,Sun=6
    ctx.fillStyle = j === todayIdx ? '#ffb74d' : '#4fc3f7';
    ctx.fillRect(x, y, barW2, barH);
  }

  // Last week line (solid, orange-ish, with dots)
  function lx(i) { return M.left + slotW * i + slotW / 2; }
  function ly(i) { return M.top + plotH - plotH * lastWeekVals[i] / maxT; }

  // Subtle fill under last week line
  ctx.beginPath();
  ctx.moveTo(lx(0), M.top + plotH);
  for (var m = 0; m < 7; m++) { ctx.lineTo(lx(m), ly(m)); }
  ctx.lineTo(lx(6), M.top + plotH); ctx.closePath();
  ctx.fillStyle = 'rgba(255,183,77,0.06)'; ctx.fill();

  // Solid line
  ctx.beginPath();
  ctx.strokeStyle = '#81c784'; ctx.lineWidth = 2;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.moveTo(lx(0), ly(0));
  for (var m = 1; m < 7; m++) { ctx.lineTo(lx(m), ly(m)); }
  ctx.stroke();

  // Dots
  for (var p = 0; p < 7; p++) {
    if (lastWeekVals[p] > 0) {
      ctx.beginPath(); ctx.arc(lx(p), ly(p), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#81c784'; ctx.fill();
    }
  }

  // Label
  ctx.font = '9px sans-serif'; ctx.fillStyle = '#81c784'; ctx.textAlign = 'left';
  ctx.fillText('last wk', lx(6) + 6, ly(6));

  // X labels
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (var j = 0; j < 7; j++) { ctx.fillText(dayNames[j], lx(j), M.top + plotH + 6); }

  // Hover
  canvas.onmousemove = function(e) {
    var cr = canvas.getBoundingClientRect(), mx = e.clientX - cr.left;
    var idx = Math.floor((mx - M.left) / (slotW || 1));
    if (idx < 0 || idx >= 7) { hideTooltip('claudeChartTooltip'); drawWeekChart(data); return; }
    showTooltip('claudeChartTooltip', e, dayNames[idx] + ': this wk ' + fmtNum(thisWeekVals[idx]) + ' tok | last wk ' + fmtNum(lastWeekVals[idx]) + ' tok');
    drawWeekChart(data);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(M.left + idx * slotW + (slotW - barW2) / 2, M.top, barW2, plotH);
  };
  canvas.onmouseleave = function() { hideTooltip('claudeChartTooltip'); drawWeekChart(data); };

  // Clear day comparison
  el('dayComparison').innerHTML = '';
  el('costProjection').style.display = 'none';
}

// ================ MONTH: daily bars + separate cumulative chart ================
function drawMonthChart(data, f) {
  var daysInM = daysInMonth();
  var dayNow = dayOfMonth();
  var today = todayStr();
  var ym = currentYearMonth();
  var ds = f.dailyStats || [];
  var tokenValues = [];
  var dateLabels = [];
  var dailyByDay = {};

  for (var d0 = 1; d0 <= daysInM; d0++) {
    tokenValues.push(0);
    dateLabels.push(ym + '-' + String(d0).padStart(2, '0'));
  }

  for (var di = 0; di < ds.length; di++) {
    var stat = ds[di];
    var dayNum = parseInt(stat.date.slice(8, 10), 10);
    if (dayNum < 1 || dayNum > daysInM) { continue; }
    tokenValues[dayNum - 1] += tokenTotal(stat);
    dailyByDay[dayNum] = stat;
  }

  var maxT = Math.max.apply(null, tokenValues.concat([1]));

  // Cumulative and projected: both use real calendar days, not compacted data days.
  var cumulative = [];
  var running = 0;
  var firstDataIdx = -1;
  for (var i = 0; i < tokenValues.length; i++) {
    if (tokenValues[i] > 0) {
      if (firstDataIdx === -1) { firstDataIdx = i; }
    }
    running += tokenValues[i];
    cumulative.push(running);
  }
  var todayIdx = Math.min(Math.max(dayNow - 1, 0), daysInM - 1);
  var actualEndIdx = todayIdx;
  var totalMTD = cumulative[actualEndIdx] || 0;
  var elapsedMonthDays = elapsedCurrentMonthDays(new Date());
  var projectedTotal = computeProjection(totalMTD, elapsedMonthDays, daysInM);
  var dailyAvg = totalMTD / Math.max(MIN_PROJECTION_DAY_FRACTION, elapsedMonthDays);

  // ---- Chart 1: Daily bars + avg reference line ----
  var container1 = el('claudeChartContainer');
  var canvas1 = el('claudeTrendChart');
  if (container1 && canvas1) {
    el('claudeChartTitle').textContent = 'Token Usage (This Month)';

    var dpr = window.devicePixelRatio || 1;
    var rect = container1.getBoundingClientRect();
    var w = rect.width - 24; if (w < 80) { w = 80; }
    var h = 160;
    canvas1.width = w * dpr; canvas1.height = h * dpr;
    canvas1.style.width = w + 'px'; canvas1.style.height = h + 'px';
    var ctx = canvas1.getContext('2d'); ctx.scale(dpr, dpr);

    var maxY = Math.max(maxT, dailyAvg * 2, 1);

    var M = { top: 10, right: 16, bottom: 24, left: 50 };
    var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
    var plotH = h - M.top - M.bottom;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var gY = M.top + plotH * i / 4;
      ctx.beginPath(); ctx.moveTo(M.left, gY); ctx.lineTo(w - M.right, gY); ctx.stroke();
    }

    ctx.font = '10px sans-serif';
    ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var i = 0; i <= 4; i++) {
      ctx.fillText(fmtNum(Math.round(maxY * (4 - i) / 4)), M.left - 6, M.top + plotH * i / 4);
    }

    var n = daysInM;
    function cx(i) { return M.left + plotW * i / Math.max(1, n - 1); }

    // Monthly average line
    if (dailyAvg > 0 && dailyAvg < maxY * 0.95) {
      var avgY = M.top + plotH - plotH * dailyAvg / maxY;
      ctx.beginPath();
      ctx.strokeStyle = '#81c784'; ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.moveTo(M.left, avgY); ctx.lineTo(w - M.right, avgY);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '8px sans-serif'; ctx.fillStyle = '#81c784'; ctx.textAlign = 'right';
      ctx.fillText('avg', w - M.right, avgY - 3);
    }

    // Daily bars
    var slotW = plotW / Math.max(1, n);
    var barW = Math.max(2, Math.min(12, slotW * 0.55));
    for (var j = 0; j < n; j++) {
      var barH = plotH * tokenValues[j] / maxY;
      var x = cx(j) - barW / 2;
      var isToday = dateLabels[j] === today;
      ctx.fillStyle = isToday ? '#ffb74d' : '#4fc3f7';
      ctx.fillRect(x, M.top + plotH - barH, barW, barH);
    }

    // X labels: fixed calendar day numbers for the whole month.
    ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
    ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var labelStep = n <= 15 ? 1 : Math.ceil(n / 10);
    for (var j = 0; j < n; j += labelStep) {
      ctx.fillText(String(j + 1), cx(j), M.top + plotH + 4);
    }

    // Hover
    canvas1.onmousemove = function(e) {
      var cr = canvas1.getBoundingClientRect(), mx = e.clientX - cr.left;
      var idx = Math.round((mx - M.left) / plotW * (n - 1));
      if (idx < 0 || idx >= n) { hideTooltip('claudeChartTooltip'); drawMonthChart(data, f); return; }
      var statForDay = dailyByDay[idx + 1];
      var calls = statForDay ? (' | ' + fmtNum(statForDay.callCount || 0) + ' calls') : '';
      showTooltip('claudeChartTooltip', e, dateLabels[idx] + ': ' + fmtNum(tokenValues[idx]) + ' tok' + calls);
      drawMonthChart(data, f);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(cx(idx) - slotW / 2, M.top, slotW, plotH);
    };
    canvas1.onmouseleave = function() { hideTooltip('claudeChartTooltip'); drawMonthChart(data, f); };
  }

  // ---- Chart 2: Cumulative + projected line chart ----
  var cumulDiv = el('monthCumulSection');
  if (!cumulDiv) {
    var pieDiv = el('pieChartContainer');
    cumulDiv = document.createElement('div');
    cumulDiv.id = 'monthCumulSection';
    cumulDiv.className = 'chart-container';
    cumulDiv.style.position = 'relative';
    cumulDiv.innerHTML = '<div class="chart-title">Cumulative & Projection</div><canvas id="monthCumulCanvas"></canvas><div class="chart-hover-band" id="monthCumulHover"></div><div class="chart-tooltip" id="monthCumulTooltip"></div>';
    if (pieDiv && pieDiv.parentNode) {
      pieDiv.parentNode.insertBefore(cumulDiv, pieDiv);
    }
  }
  cumulDiv.style.display = '';

  var canvas2 = el('monthCumulCanvas');
  if (!canvas2) { return; }

  var dpr2 = window.devicePixelRatio || 1;
  var rect2 = cumulDiv.getBoundingClientRect();
  var w2 = rect2.width - 24; if (w2 < 80) { w2 = 80; }
  var h2 = 180;
  canvas2.width = w2 * dpr2; canvas2.height = h2 * dpr2;
  canvas2.style.width = w2 + 'px'; canvas2.style.height = h2 + 'px';
  var ctx2 = canvas2.getContext('2d'); ctx2.scale(dpr2, dpr2);

  var maxCumul = Math.max(projectedTotal, totalMTD, 1);

  var M2 = { top: 10, right: 16, bottom: 24, left: 50 };
  var plotW2 = w2 - M2.left - M2.right; if (plotW2 < 20) { plotW2 = 20; }
  var plotH2 = h2 - M2.top - M2.bottom;

  ctx2.clearRect(0, 0, w2, h2);

  ctx2.strokeStyle = 'rgba(128,128,128,0.12)'; ctx2.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var gY = M2.top + plotH2 * i / 4;
    ctx2.beginPath(); ctx2.moveTo(M2.left, gY); ctx2.lineTo(w2 - M2.right, gY); ctx2.stroke();
  }

  ctx2.font = '10px sans-serif';
  ctx2.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx2.textAlign = 'right'; ctx2.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    ctx2.fillText(fmtNum(Math.round(maxCumul * (4 - i) / 4)), M2.left - 6, M2.top + plotH2 * i / 4);
  }

  function cx2(i) { return M2.left + plotW2 * i / Math.max(1, daysInM - 1); }

  // Green cumulative line: starts at the first real data day, so early empty days stay empty.
  function cumulY(i) { return M2.top + plotH2 - plotH2 * cumulative[i] / maxCumul; }
  if (firstDataIdx >= 0 && firstDataIdx <= actualEndIdx) {
    ctx2.beginPath();
    ctx2.strokeStyle = '#81c784'; ctx2.lineWidth = 2;
    ctx2.setLineDash([5, 5]);
    ctx2.moveTo(cx2(firstDataIdx), cumulY(firstDataIdx));
    for (var m = firstDataIdx + 1; m <= actualEndIdx; m++) { ctx2.lineTo(cx2(m), cumulY(m)); }
    ctx2.stroke(); ctx2.setLineDash([]);
    // Green dots only on days with real usage.
    for (var p = firstDataIdx; p <= actualEndIdx; p++) {
      if (tokenValues[p] <= 0) { continue; }
      ctx2.beginPath(); ctx2.arc(cx2(p), cumulY(p), 3, 0, Math.PI * 2);
      ctx2.fillStyle = '#81c784'; ctx2.fill();
    }
    ctx2.font = '9px sans-serif'; ctx2.fillStyle = '#81c784'; ctx2.textAlign = 'left';
    ctx2.fillText('cumulative', cx2(actualEndIdx) + 4, cumulY(actualEndIdx));
  }

  // Red projected line: starts from today, not from the 1st.
  if (totalMTD > 0 && dayNow < daysInM) {
    var projY0 = M2.top + plotH2 - plotH2 * totalMTD / maxCumul;
    var projYEnd = M2.top + plotH2 - plotH2 * projectedTotal / maxCumul;
    ctx2.beginPath();
    ctx2.strokeStyle = '#e57373'; ctx2.lineWidth = 1.5;
    ctx2.setLineDash([5, 5]);
    ctx2.moveTo(cx2(todayIdx), projY0);
    ctx2.lineTo(M2.left + plotW2, projYEnd);
    ctx2.stroke(); ctx2.setLineDash([]);
    ctx2.font = '9px sans-serif'; ctx2.fillStyle = '#e57373'; ctx2.textAlign = 'left';
    ctx2.fillText('projected', M2.left + plotW2 - 55, projYEnd - 4);
  }

  // X labels
  ctx2.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx2.font = '8px sans-serif'; ctx2.textAlign = 'center'; ctx2.textBaseline = 'top';
  var labelStep2 = daysInM <= 15 ? 1 : Math.ceil(daysInM / 10);
  for (var j = 0; j < daysInM; j += labelStep2) {
    ctx2.fillText((j + 1), cx2(j), M2.top + plotH2 + 4);
  }

  var hoverBand = el('monthCumulHover');
  if (!hoverBand && cumulDiv) {
    hoverBand = document.createElement('div');
    hoverBand.id = 'monthCumulHover';
    hoverBand.className = 'chart-hover-band';
    cumulDiv.insertBefore(hoverBand, el('monthCumulTooltip'));
  }
  if (hoverBand) { hoverBand.style.display = 'none'; }
  function positionMonthCumulHover(idx) {
    if (!hoverBand) { return; }
    var bandW = Math.max(4, plotW2 / Math.max(1, daysInM));
    hoverBand.style.left = (canvas2.offsetLeft + cx2(idx) - bandW / 2) + 'px';
    hoverBand.style.top = (canvas2.offsetTop + M2.top) + 'px';
    hoverBand.style.width = bandW + 'px';
    hoverBand.style.height = plotH2 + 'px';
    hoverBand.style.display = 'block';
  }

  // Hover for chart 2
  canvas2.onmousemove = function(e) {
    var cr2 = canvas2.getBoundingClientRect(), mx2 = e.clientX - cr2.left;
    var idx2 = Math.round((mx2 - M2.left) / plotW2 * (daysInM - 1));
    if (idx2 < 0 || idx2 >= daysInM) {
      hideTooltip('monthCumulTooltip');
      if (hoverBand) { hoverBand.style.display = 'none'; }
      return;
    }
    if (idx2 <= actualEndIdx) {
      showTooltip('monthCumulTooltip', e, 'Day ' + (idx2 + 1) + ': cumulative ' + fmtNum(cumulative[idx2]) + ' tok');
    } else if (totalMTD > 0) {
      var projSpan = Math.max(1, daysInM - 1 - todayIdx);
      var projValue = totalMTD + (projectedTotal - totalMTD) * ((idx2 - todayIdx) / projSpan);
      showTooltip('monthCumulTooltip', e, 'Day ' + (idx2 + 1) + ': projected ' + fmtNum(projValue) + ' tok');
    }
    positionMonthCumulHover(idx2);
  };
  canvas2.onmouseleave = function() {
    hideTooltip('monthCumulTooltip');
    if (hoverBand) { hoverBand.style.display = 'none'; }
  };

  // Clear day-comparison text
  el('dayComparison').innerHTML = '';
  el('costProjection').style.display = 'none';

  // Projection text below cumulative chart
  var projText = cumulDiv ? cumulDiv.querySelector('.projection-text') : null;
  if (totalMTD > 0 && cumulDiv) {
    if (!projText) {
      projText = document.createElement('div');
      projText.className = 'projection-text';
      projText.style.cssText = 'font-size:12px;margin-top:6px;color:var(--vscode-descriptionForeground);text-align:center;';
      cumulDiv.appendChild(projText);
    }
    projText.innerHTML = '<b>Projected this month: ' + fmtNum(projectedTotal) + ' tokens</b>';
    var remainingDays = daysInM - dayNow;
    if (remainingDays > 0 && dailyAvg > 0) {
      projText.innerHTML += ' &middot; ~' + fmtNum(dailyAvg) + ' tok/day remaining';
    }
  } else if (projText) {
    projText.remove();
  }
}

// ================ CUMULATIVE: monthly comparison bars + cache trend line ================
function drawCumulativeChart(data) {
  var container = el('claudeChartContainer');
  var canvas = el('claudeTrendChart');
  if (!canvas || !container) { return; }
  el('claudeChartTitle').textContent = 'Monthly Comparison';

  var ds = data.dailyStats || [];
  // Group by month
  var monthMap = {};
  for (var i = 0; i < ds.length; i++) {
    var mKey = ds[i].date.slice(0, 7);
    if (!monthMap[mKey]) { monthMap[mKey] = 0; }
    monthMap[mKey] += ds[i].tokenStats.inputTokens + ds[i].tokenStats.outputTokens + ds[i].tokenStats.cacheReadTokens;
  }
  var allMonths = Object.keys(monthMap).sort();
  if (allMonths.length === 0) { return; }
  var months = recentItems(allMonths, TREND_POINT_LIMIT);
  el('claudeChartTitle').textContent = allMonths.length > TREND_POINT_LIMIT ? 'Monthly Comparison (Recent 12)' : 'Monthly Comparison';

  var monthVals = months.map(function(m) { return monthMap[m]; });
  var maxV = Math.max.apply(null, monthVals) || 1;

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  var M = { top: 10, right: 16, bottom: 30, left: 50 };
  var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
  var plotH = h - M.top - M.bottom;

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var gY = M.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(M.left, gY); ctx.lineTo(w - M.right, gY); ctx.stroke();
  }

  // Y axis
  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    ctx.fillText(fmtNum(maxV * (4 - i) / 4), M.left - 6, M.top + plotH * i / 4);
  }

  // Bars
  var bCount = months.length, slotW3 = plotW / bCount, barW4 = Math.max(4, slotW3 * 0.45);
  for (var j = 0; j < bCount; j++) {
    var barH = plotH * monthVals[j] / maxV;
    var x = M.left + j * slotW3 + (slotW3 - barW4) / 2;
    var isCurrent = months[j] === currentYearMonth();
    ctx.fillStyle = isCurrent ? '#ffb74d' : '#4fc3f7';
    ctx.fillRect(x, M.top + plotH - barH, barW4, barH);
  }

  // X labels
  function mx(i) { return M.left + slotW3 * i + slotW3 / 2; }
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (var j = 0; j < bCount; j++) {
    ctx.fillText(months[j].slice(2), mx(j), M.top + plotH + 6);
  }

  // Hover
  canvas.onmousemove = function(e) {
    var cr3 = canvas.getBoundingClientRect(), mx2 = e.clientX - cr3.left;
    var idx2 = Math.floor((mx2 - M.left) / (slotW3 || 1));
    if (idx2 < 0 || idx2 >= bCount) { hideTooltip('claudeChartTooltip'); drawCumulativeChart(data); return; }
    showTooltip('claudeChartTooltip', e, months[idx2] + ': ' + fmtNum(monthVals[idx2]) + ' tokens');
    drawCumulativeChart(data);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(M.left + idx2 * slotW3 + (slotW3 - barW4) / 2, M.top, barW4, plotH);
  };
  canvas.onmouseleave = function() { hideTooltip('claudeChartTooltip'); drawCumulativeChart(data); };

  // Cache hit rate trend (separate chart below)
  drawCacheTrendChart(data.dailyStats);

  // No projection for cumulative
  el('costProjection').style.display = 'none';
  el('dayComparison').innerHTML = '';
}

// ---- Cache hit rate trend (for cumulative tab) ----
function drawCacheTrendChart(dailyStats) {
  var sourceStats = dailyStats || [];
  var trendStats = recentItems(sourceStats, TREND_POINT_LIMIT);
  var container = el('pieChartContainer');
  // We'll draw cache trend inside pie chart container (replace pie for cumulative)
  // Actually, let's use a separate approach: always show pie, but add cache trend after
  // Instead, we draw cache trend on the canvas of a new container
  // For simplicity, let's add the cache trend after the project ranking container

  // Get or create cache trend container
  var cacheDiv = el('cacheTrendSection');
  if (!cacheDiv) {
    var rankingContainer = el('topSessionsContainer');
    cacheDiv = document.createElement('div');
    cacheDiv.id = 'cacheTrendSection';
    cacheDiv.className = 'chart-container';
    cacheDiv.style.position = 'relative';
    cacheDiv.innerHTML = '<div class="chart-title">Cache Hit Rate Trend</div><canvas id="cacheTrendCanvas"></canvas><div class="chart-tooltip" id="cacheTrendTooltip"></div>';
    if (rankingContainer && rankingContainer.parentNode) {
      rankingContainer.parentNode.insertBefore(cacheDiv, rankingContainer);
    }
  }

  if (currentClaudeTab !== 'cumulative') {
    cacheDiv.style.display = 'none';
    return;
  }
  cacheDiv.style.display = '';
  var cacheTitle = cacheDiv.querySelector('.chart-title');
  if (cacheTitle) {
    cacheTitle.textContent = sourceStats.length > TREND_POINT_LIMIT ? 'Cache Hit Rate Trend (Recent 12)' : 'Cache Hit Rate Trend';
  }

  var canvas = el('cacheTrendCanvas');
  if (!canvas || trendStats.length < 2) {
    if (canvas) { canvas.style.display = 'none'; }
    return;
  }
  canvas.style.display = 'block';

  var dpr = window.devicePixelRatio || 1;
  var rect = cacheDiv.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = 160;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  var cacheRates = trendStats.map(function(d) {
    var totalInput = d.tokenStats.inputTokens + d.tokenStats.cacheReadTokens;
    return totalInput > 0 ? d.tokenStats.cacheReadTokens / totalInput : 0;
  });

  var minRate = Math.min.apply(null, cacheRates);
  var maxRate = Math.max.apply(null, cacheRates);
  var ratePad = Math.max(0.02, (maxRate - minRate) * 0.2);
  var yMin = Math.max(0, minRate - ratePad);
  var yMax = Math.min(1, maxRate + ratePad);
  if (yMax - yMin < 0.05) {
    var centerRate = (yMax + yMin) / 2;
    yMin = Math.max(0, centerRate - 0.025);
    yMax = Math.min(1, centerRate + 0.025);
  }

  var M = { top: 10, right: 16, bottom: 28, left: 44 };
  var plotW = w - M.left - M.right; if (plotW < 20) { plotW = 20; }
  var plotH = h - M.top - M.bottom;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(128,128,128,0.12)'; ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var gY = M.top + plotH * i / 4;
    ctx.beginPath(); ctx.moveTo(M.left, gY); ctx.lineTo(w - M.right, gY); ctx.stroke();
  }

  ctx.font = '10px sans-serif';
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (var i = 0; i <= 4; i++) {
    var val = yMax - (yMax - yMin) * i / 4;
    ctx.fillText((val * 100).toFixed(0) + '%', M.left - 4, M.top + plotH * i / 4);
  }

  function cx(i) { return M.left + plotW * i / Math.max(1, trendStats.length - 1); }
  function cy(i) { return M.top + plotH - plotH * (cacheRates[i] - yMin) / (yMax - yMin); }

  // Fill
  ctx.beginPath(); ctx.moveTo(cx(0), M.top + plotH);
  for (var k = 0; k < trendStats.length; k++) { ctx.lineTo(cx(k), cy(k)); }
  ctx.lineTo(cx(trendStats.length - 1), M.top + plotH); ctx.closePath();
  ctx.fillStyle = 'rgba(129, 199, 132, 0.08)'; ctx.fill();

  // Line
  ctx.beginPath(); ctx.strokeStyle = '#81c784'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.moveTo(cx(0), cy(0));
  for (var m = 1; m < trendStats.length; m++) { ctx.lineTo(cx(m), cy(m)); }
  ctx.stroke();

  for (var p = 0; p < trendStats.length; p++) {
    ctx.beginPath(); ctx.arc(cx(p), cy(p), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#81c784'; ctx.fill();
  }

  // X labels
  ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
  ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  var labStep = trendStats.length <= 10 ? 1 : Math.ceil(trendStats.length / 8);
  for (var j = 0; j < trendStats.length; j += labStep) {
    ctx.fillText(trendStats[j].date.slice(5), cx(j), M.top + plotH + 4);
  }

  canvas.onmousemove = function(e) {
    var cr4 = canvas.getBoundingClientRect(), mx3 = e.clientX - cr4.left;
    var idx3 = Math.round((mx3 - M.left) / plotW * (trendStats.length - 1));
    if (idx3 < 0 || idx3 >= trendStats.length) { hideTooltip('cacheTrendTooltip'); drawCacheTrendChart(dailyStats); return; }
    showTooltip('cacheTrendTooltip', e, trendStats[idx3].date + ': ' + (cacheRates[idx3] * 100).toFixed(1) + '%');
    drawCacheTrendChart(dailyStats);
    ctx.beginPath(); ctx.arc(cx(idx3), cy(idx3), 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(129, 199, 132, 0.3)'; ctx.fill();
    ctx.strokeStyle = '#81c784'; ctx.lineWidth = 2; ctx.stroke();
  };
  canvas.onmouseleave = function() { hideTooltip('cacheTrendTooltip'); drawCacheTrendChart(dailyStats); };
}

// ---- Model pie ----
function drawModelPie(modelUsage) {
  var container = el('pieChartContainer');
  var canvas = el('modelPieChart');
  if (!canvas || !container || modelUsage.length === 0) { return; }
  container.style.display = 'block';

  var dpr = window.devicePixelRatio || 1;
  var rect = container.getBoundingClientRect();
  var w = rect.width - 24; if (w < 80) { w = 80; }
  var h = 200;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

  var colors = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1'];
  var modelTokens = modelUsage.map(function(m) { return m.inputTokens + m.outputTokens + m.cacheReadTokens; });
  var totalT = modelTokens.reduce(function(a,b){return a+b;},0);
  if (totalT === 0) { return; }

  var cxP = w * 0.35, cyP = h * 0.5;
  var radius = Math.min(cxP - 10, cyP - 10, 70);
  var startA = -Math.PI / 2;
  for (var i = 0; i < modelUsage.length; i++) {
    var slice = (modelTokens[i] / totalT) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cxP, cyP);
    ctx.arc(cxP, cyP, radius, startA, startA + slice); ctx.closePath();
    ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    ctx.strokeStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e'; ctx.lineWidth = 2; ctx.stroke();
    startA += slice;
  }

  var lx = cxP + radius + 16, ly = cyP - (modelUsage.length * 18) / 2;
  ctx.font = '11px sans-serif'; ctx.textBaseline = 'middle';
  for (var i = 0; i < modelUsage.length; i++) {
    var y = ly + i * 20;
    ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(lx, y - 5, 10, 10);
    ctx.fillStyle = getComputedStyle(document.body).color || '#ccc'; ctx.textAlign = 'left';
    ctx.fillText(modelUsage[i].model + ' (' + ((modelTokens[i] / totalT) * 100).toFixed(0) + '%)', lx + 14, y);
  }
}

// ---- Project ranking ----
function renderProjectRanking(projects, data) {
  var list = el('topSessionsList');
  if (!list) { return; }
  el('rankingTitle').textContent = 'Project Ranking';

  // Filter projects to those appearing in the current tab's data if possible
  // For simplicity, show cumulative project ranking
  var html = '';
  var topN = Math.min(projects.length, 5);
  if (topN === 0) { list.innerHTML = ''; return; }

  for (var i = 0; i < topN; i++) {
    var p = projects[i];
    var tokens = p.tokenStats.inputTokens + p.tokenStats.outputTokens + p.tokenStats.cacheReadTokens;
    var name = decodeProjectName(p.projectDir);
    var pPath = p.projectPath || '';
    html += '<div class="session-row' + (pPath ? ' clickable' : '') + '"' + (pPath ? ' data-path="' + escapeHtml(pPath) + '"' : '') + '>' +
      '<span>' + (pPath ? '[open] ' : '') + '#' + (i + 1) + ' ' + escapeHtml(name) + ' (' + p.callCount + ' calls)</span>' +
      '<span>' + fmtNum(tokens) + ' tok</span></div>';
  }
  list.innerHTML = html;

  var rows = list.querySelectorAll('.clickable');
  for (var r = 0; r < rows.length; r++) {
    rows[r].addEventListener('click', function() {
      var p = this.getAttribute('data-path');
      if (p) { vscode.postMessage({ command: 'openFolder', path: p }); }
    });
  }
}

// ==============================
//  TAB-SPECIFIC EXTRA CONTENT
// ==============================

function buildTabExtra(data, f) {
  var metricsDiv = el('tabMetrics');
  var extraDiv = el('tabExtra');
  if (!metricsDiv || !extraDiv) { return; }

  var claudeSection = el('claudeDataSection');
  var chartContainer = el('claudeChartContainer');
  var ranking = el('topSessionsContainer');
  var cumulDiv = el('monthCumulSection');
  var pieContainer = el('pieChartContainer');

  // IMPORTANT: rescue moved elements BEFORE clearing innerHTML

  // Put chart container back between tabExtra and tabMetrics
  if (chartContainer && extraDiv.contains(chartContainer)) {
    chartContainer.style.display = '';
    claudeSection.insertBefore(chartContainer, extraDiv);
  }
  // Put ranking back after tabExtra
  if (ranking && metricsDiv.contains(ranking)) {
    claudeSection.insertBefore(ranking, extraDiv);
  }
  // Put month cumulative chart back between chart and pie
  if (cumulDiv && extraDiv.contains(cumulDiv)) {
    if (pieContainer && pieContainer.parentNode) {
      claudeSection.insertBefore(cumulDiv, pieContainer);
    } else {
      claudeSection.insertBefore(cumulDiv, extraDiv);
    }
  }

  // Now safe to clear
  metricsDiv.innerHTML = '';
  extraDiv.innerHTML = '';

  if (currentClaudeTab === 'today') {
    // Metrics above chart
    if (metricsDiv) { buildTodayMetrics(data, f, metricsDiv); }
    // Extra content below chart
    if (extraDiv) { buildTokenComposition(data, f, extraDiv); }
  } else if (currentClaudeTab === 'week') {
    if (metricsDiv) { buildWeekMetrics(data, metricsDiv); }
    if (extraDiv) { buildWeekComparisonTable(data, extraDiv); }
    // Move chart container below table
    var chartContainer = el('claudeChartContainer');
    if (chartContainer && extraDiv) { extraDiv.appendChild(chartContainer); }
  } else if (currentClaudeTab === 'month') {
    if (extraDiv) {
      // Move cumulative chart into tabExtra above export
      var cumulDiv = el('monthCumulSection');
      if (cumulDiv) { extraDiv.appendChild(cumulDiv); cumulDiv.style.display = ''; }
      buildCalendarHeatmap(data, f, extraDiv);
      buildExportButton(extraDiv);
    }
  } else if (currentClaudeTab === 'cumulative') {
    if (metricsDiv) { buildCumulMetrics(data, metricsDiv); }
    // Move Project Ranking below Overall Metrics
    var ranking = el('topSessionsContainer');
    if (ranking && metricsDiv) { metricsDiv.appendChild(ranking); }
  }
}

// ---------- TODAY METRICS ----------
function buildTodayMetrics(data, f, parent) {
  var ds = f.dailyStats;
  var todayD = ds.length > 0 ? ds[ds.length - 1] : null;
  var todayToks = 0, todayCalls = 0;
  if (todayD) {
    todayToks = todayD.tokenStats.inputTokens + todayD.tokenStats.outputTokens + todayD.tokenStats.cacheReadTokens;
    todayCalls = todayD.callCount || 0;
  }
  var avgPerCall = todayCalls > 0 ? Math.round(todayToks / todayCalls) : 0;

  var allDs = data.dailyStats || [];
  var todayKey = todayStr();
  var recent7 = allDs.filter(function(d) { return d.date < todayKey; }).slice(-7);
  var total7 = 0;
  for (var i = 0; i < recent7.length; i++) {
    total7 += tokenTotal(recent7[i]);
  }
  var avg7 = recent7.length > 0 ? total7 / recent7.length : 0;
  var vs7 = avg7 > 0 ? ((todayToks - avg7) / avg7 * 100) : null;
  var vs7Text = vs7 === null ? '--' : (vs7 > 0 ? '+' : '') + vs7.toFixed(0) + '%';
  var vs7Cls = vs7 === null ? '' : vs7 > 15 ? 'up' : vs7 < -15 ? 'down' : '';

  var projectedToday = computeProjection(todayToks, Math.max(dayProgress(new Date()), MIN_PROJECTION_DAY_FRACTION), 1);
  var alertLevel = 'info';
  var alertText = 'Need more history for a 7-day baseline.';
  if (avg7 > 0) {
    var projectedRatio = projectedToday / avg7;
    var currentRatio = todayToks / avg7;
    alertLevel = 'ok';
    alertText = 'On track: projected ' + fmtNum(projectedToday) + ' tok today vs ' + fmtNum(avg7) + ' 7-day avg.';
    if (currentRatio >= 3 || projectedRatio >= 3) {
      alertLevel = 'danger';
      alertText = 'High usage: projected ' + fmtNum(projectedToday) + ' tok today, ' + ((projectedRatio - 1) * 100).toFixed(0) + '% above 7-day avg.';
    } else if (projectedRatio >= 2) {
      alertLevel = 'warning';
      alertText = 'Watch: projected ' + fmtNum(projectedToday) + ' tok today, ' + ((projectedRatio - 1) * 100).toFixed(0) + '% above 7-day avg.';
    }
  }

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Today Metrics</div>';
  html += '<div style="display:flex;gap:24px;font-size:12px;">';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Avg Tokens / Call</span><br><b>' + fmtNum(avgPerCall) + '</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Today vs 7-day Avg</span><br><b class="' + vs7Cls + '">' + vs7Text + '</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Total Calls Today</span><br><b>' + fmtNum(todayCalls) + '</b></div>';
  html += '</div>';
  html += '<div class="usage-alert ' + alertLevel + '"><span class="usage-alert-label">Today Alert</span><span>' + alertText + '</span></div>';
  html += '</div>';
  parent.innerHTML += html;
}

// ---------- TODAY TOKEN COMPOSITION (horizontal stacked bar) ----------
function buildTokenComposition(data, f, parent) {
  var ds = f.dailyStats;
  if (ds.length === 0) { return; }
  var d = ds[ds.length - 1];
  var inputT = d.tokenStats.inputTokens || 0;
  var outputT = d.tokenStats.outputTokens || 0;
  var cacheRead = d.tokenStats.cacheReadTokens || 0;
  var cacheCreate = d.tokenStats.cacheCreateTokens || 0;
  var totalT = inputT + outputT + cacheRead + cacheCreate;
  if (totalT === 0) { return; }

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Today Token Composition</div>';
  html += '<div style="position:relative;">';
  html += '<canvas id="compCanvas" style="width:100%;height:48px;"></canvas>';
  html += '<div class="chart-tooltip" id="compTooltip"></div></div>';
  html += '<div style="display:flex;gap:12px;margin-top:6px;font-size:10px;flex-wrap:wrap;">';
  html += '<span style="color:#4fc3f7;">Input ' + fmtNum(inputT) + '</span>';
  html += '<span style="color:#e57373;">Output ' + fmtNum(outputT) + '</span>';
  html += '<span style="color:#81c784;">Cache Read ' + fmtNum(cacheRead) + '</span>';
  html += '<span style="color:#ffb74d;">Cache Write ' + fmtNum(cacheCreate) + '</span>';
  html += '</div></div>';
  parent.innerHTML += html;

  // Draw stacked bar on canvas
  setTimeout(function() {
    var canvas = el('compCanvas');
    if (!canvas) { return; }
    var container = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var rect = container.getBoundingClientRect();
    var w = rect.width - 24; if (w < 80) { w = 80; }
    var h = 28;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

    var parts = [
      { val: inputT, color: '#4fc3f7', label: 'Input' },
      { val: outputT, color: '#e57373', label: 'Output' },
      { val: cacheRead, color: '#81c784', label: 'Cache Read' },
      { val: cacheCreate, color: '#ffb74d', label: 'Cache Write' }
    ];
    var x = 0;
    var segBounds = [];
    for (var i = 0; i < parts.length; i++) {
      var pw = Math.max(1, (parts[i].val / totalT) * w);
      ctx.fillStyle = parts[i].color;
      ctx.fillRect(x, 0, pw, h);
      // Label on segment if wide enough
      if (pw > 30) {
        ctx.fillStyle = '#000'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(parts[i].label + ' ' + (parts[i].val / totalT * 100).toFixed(0) + '%', x + pw / 2, h / 2);
      }
      segBounds.push({ x: x, w: pw, part: parts[i] });
      x += pw;
    }
    // Hover
    canvas.onmousemove = function(e) {
      var cr = canvas.getBoundingClientRect(), mx = e.clientX - cr.left;
      for (var s = 0; s < segBounds.length; s++) {
        if (mx >= segBounds[s].x && mx <= segBounds[s].x + segBounds[s].w) {
          var p = segBounds[s].part;
          showTooltip('compTooltip', e, p.label + ': ' + fmtNum(p.val) + ' tok (' + (p.val / totalT * 100).toFixed(1) + '%)');
          return;
        }
      }
    };
    canvas.onmouseleave = function() { hideTooltip('compTooltip'); };
  }, 5);
}

// ---------- TODAY HEAVY CALLS ----------
function buildHeavyCallsList(data, parent) {
  var calls = data.todayCallDetails || [];
  if (calls.length === 0) { return; }

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Top 10 Heaviest Calls Today</div>';

  // Summary
  var largest = calls[0];
  html += '<div style="font-size:11px;margin-bottom:8px;color:var(--vscode-descriptionForeground);">Largest call today: <b>' + escapeHtml(largest.projectName) + '</b> / ' + largest.time + ' / ' + fmtNum(largest.totalTokens) + ' tokens</div>';

  // Table header
  html += '<div style="font-size:10px;display:grid;grid-template-columns:50px 1fr 0.8fr 0.8fr 0.8fr;gap:4px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border);padding-bottom:4px;margin-bottom:4px;">';
  html += '<span>Time</span><span>Project</span><span>Model</span><span>Tokens</span><span>Cache</span>';
  html += '</div>';

  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    var cachePct = (c.cacheHitRate * 100).toFixed(0);
    html += '<div style="font-size:10px;display:grid;grid-template-columns:50px 1fr 0.8fr 0.8fr 0.8fr;gap:4px;padding:2px 0;border-bottom:1px solid var(--vscode-widget-border);">';
    html += '<span>' + c.time + '</span>';
    html += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(c.projectName) + '</span>';
    html += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(c.model) + '</span>';
    html += '<span>' + fmtNum(c.totalTokens) + '</span>';
    html += '<span>' + cachePct + '%</span>';
    html += '</div>';
  }
  html += '</div>';
  parent.innerHTML += html;
}

// ---------- WEEK METRICS ----------
function buildWeekMetrics(data, parent) {
  var thisWeek = getWeekToDateRange(0);
  var lastWeek = getWeekToDateRange(-1);
  var ds = data.dailyStats || [];

  var thisTotal = 0, lastTotal = 0;
  for (var i = 0; i < ds.length; i++) {
    var d = ds[i];
    var t = d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
    if (d.date >= thisWeek.start && d.date <= thisWeek.end) { thisTotal += t; }
    if (d.date >= lastWeek.start && d.date <= lastWeek.end) { lastTotal += t; }
  }

  var now = new Date();
  var daysElapsedW = elapsedCurrentWeekDays(now);
  var wow = lastTotal > 0 ? ((thisTotal - lastTotal) / lastTotal * 100) : 0;
  var cls = wow > 0 ? 'up' : 'down';
  var avgDay = daysElapsedW > 0 ? Math.round(thisTotal / daysElapsedW) : 0;

  // Projection
  var projW = computeProjection(thisTotal, daysElapsedW, 7);

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Week Metrics</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:12px;">';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">WoW Change</span><br><b class="' + cls + '">' + (wow > 0 ? '+' : '') + wow.toFixed(1) + '%</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Weekly Avg / Day</span><br><b>' + fmtNum(avgDay) + ' tok</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Projected This Week</span><br><b>' + fmtNum(projW) + ' tok</b></div>';
  html += '</div></div>';

  // Hide the separate projection div
  el('costProjection').style.display = 'none';
  parent.innerHTML += html;
}

// ---------- WEEK COMPARISON TABLE ----------
function buildWeekComparisonTable(data, parent) {
  var thisWeek = getWeekToDateRange(0);
  var lastWeek = getWeekToDateRange(-1);
  var ds = data.dailyStats || [];

  function statsFor(dates) {
    var start = dates.start, end = dates.end;
    var tokens = 0, calls = 0, cost = 0, inTok = 0, cacheRead = 0;
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      if (d.date >= start && d.date <= end) {
        tokens += d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
        calls += d.callCount || 0;
        cost += d.cost || 0;
        inTok += d.tokenStats.inputTokens;
        cacheRead += d.tokenStats.cacheReadTokens;
      }
    }
    var totalInput = inTok + cacheRead;
    var cacheRate = totalInput > 0 ? cacheRead / totalInput : 0;
    var avgPerCall = calls > 0 ? Math.round(tokens / calls) : 0;
    return { tokens: tokens, calls: calls, cost: cost, cacheRate: cacheRate, avgPerCall: avgPerCall };
  }

  var tw = statsFor(thisWeek);
  var lw = statsFor(lastWeek);

  function changeStr(cur, prev) {
    if (prev === 0) { return cur > 0 ? 'NEW' : '--'; }
    var pct = ((cur - prev) / prev * 100);
    var cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    return '<span class="' + cls + '">' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%</span>';
  }

  function rateChange(cur, prev) {
    if (prev === 0) { return cur > 0 ? 'NEW' : '--'; }
    return ((cur - prev) * 100).toFixed(1) + 'pp';
  }

  function alignedChangeStr(cur, prev) {
    if (prev === 0) { return cur > 0 ? 'NEW' : '--'; }
    var pct = ((cur - prev) / prev * 100);
    var cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    return '<span class="' + cls + '">' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%</span>';
  }

  function alignedRateChange(cur, prev) {
    if (prev === 0) { return cur > 0 ? 'NEW' : '--'; }
    var diff = (cur - prev) * 100;
    var cls = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
    return '<span class="' + cls + '">' + (diff > 0 ? '+' : '') + diff.toFixed(1) + 'pp</span>';
  }

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Week-over-Week Comparison (same days)</div>';
  html += '<table class="comparison-table">';
  html += '<colgroup><col style="width:35%"><col style="width:22%"><col style="width:22%"><col style="width:21%"></colgroup>';
  html += '<thead><tr><th>Metric</th><th>This Week</th><th>Last Week</th><th>Change</th></tr></thead><tbody>';
  html += '<tr><td>Tokens</td><td>' + fmtNum(tw.tokens) + '</td><td>' + fmtNum(lw.tokens) + '</td><td>' + alignedChangeStr(tw.tokens, lw.tokens) + '</td></tr>';
  html += '<tr><td>Calls</td><td>' + fmtNum(tw.calls) + '</td><td>' + fmtNum(lw.calls) + '</td><td>' + alignedChangeStr(tw.calls, lw.calls) + '</td></tr>';
  html += '<tr><td>Avg Tokens/Call</td><td>' + fmtNum(tw.avgPerCall) + '</td><td>' + fmtNum(lw.avgPerCall) + '</td><td>' + alignedChangeStr(tw.avgPerCall, lw.avgPerCall) + '</td></tr>';
  html += '<tr><td>Cache Hit Rate</td><td>' + (tw.cacheRate * 100).toFixed(1) + '%</td><td>' + (lw.cacheRate * 100).toFixed(1) + '%</td><td>' + alignedRateChange(tw.cacheRate, lw.cacheRate) + '</td></tr>';
  html += '</tbody></table></div>';
  parent.innerHTML += html;

  // Draw Week chart at the bottom
  setTimeout(function() { drawWeekChart(data); }, 0);
}

// ---------- MONTH CALENDAR HEATMAP ----------
function buildCalendarHeatmap(data, f, parent) {
  var ds = f.dailyStats;
  if (ds.length === 0) { return; }

  var daysInM = daysInMonth();
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var firstDayOfWeek = new Date(year, month, 1).getDay(); // 0=Sun

  // Build token map: day -> tokens
  var dayTokens = {};
  for (var i = 0; i < ds.length; i++) {
    var day = parseInt(ds[i].date.slice(8, 10), 10);
    dayTokens[day] = ds[i].tokenStats.inputTokens + ds[i].tokenStats.outputTokens + ds[i].tokenStats.cacheReadTokens;
  }
  var maxVal = 1;
  for (var d = 1; d <= daysInM; d++) { if (dayTokens[d] > maxVal) { maxVal = dayTokens[d]; } }

  var html = '<div class="chart-container" style="padding:10px 14px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">' + year + '-' + String(month + 1).padStart(2, '0') + ' Usage Heatmap</div>';
  html += '<div style="position:relative;">';
  html += '<canvas id="heatmapCanvas" style="width:100%;height:130px;"></canvas>';
  html += '<div class="chart-tooltip" id="heatmapTooltip"></div></div>';
  html += '<div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;font-size:9px;margin-top:4px;color:var(--vscode-descriptionForeground);">';
  html += '<span>Less</span><span style="width:12px;height:12px;background:rgba(79,195,247,0.15);"></span><span style="width:12px;height:12px;background:rgba(79,195,247,0.5);"></span><span style="width:12px;height:12px;background:#4fc3f7;"></span><span>More</span>';
  html += '</div></div>';
  parent.innerHTML += html;

  setTimeout(function() {
    var canvas = el('heatmapCanvas');
    if (!canvas) { return; }
    var container2 = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    var rect = container2.getBoundingClientRect();
    var w = rect.width - 24; if (w < 120) { w = 120; }
    var h = 120;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

    var dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    var cellW = (w - 30) / 7;
    var cellH = h / 7;
    var todayDay = new Date().getDate();

    // Day labels
    ctx.font = '9px sans-serif'; ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var j = 0; j < 7; j++) {
      ctx.fillText(dayLabels[j], 14, cellH / 2 + j * cellH + cellH * 0.1);
    }

    // Cells
    for (var day = 1; day <= daysInM; day++) {
      var dow = (firstDayOfWeek + day - 1) % 7;
      var row = dow;
      var col = Math.floor((firstDayOfWeek + day - 1) / 7);
      var x = 28 + col * cellW + 2;
      var y = row * cellH + 2;
      var cw = cellW - 4;
      var ch = cellH - 4;

      var val = dayTokens[day] || 0;
      var intensity = maxVal > 0 ? val / maxVal : 0;
      var alpha = 0.1 + intensity * 0.9;
      ctx.fillStyle = day === todayDay ? '#ffb74d' : 'rgba(79,195,247,' + alpha.toFixed(2) + ')';
      ctx.fillRect(x, y, cw, ch);

      // Day number
      ctx.font = '8px sans-serif'; ctx.fillStyle = '#ccc'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(day), x + cw / 2, y + ch / 2);
    }

    // Hover
    canvas.onmousemove = function(e) {
      var cr = canvas.getBoundingClientRect(), mx2 = e.clientX - cr.left, my2 = e.clientY - cr.top;
      for (var day = 1; day <= daysInM; day++) {
        var dow2 = (firstDayOfWeek + day - 1) % 7;
        var row2 = dow2;
        var col2 = Math.floor((firstDayOfWeek + day - 1) / 7);
        var cx2 = 28 + col2 * cellW + 2;
        var cy2 = row2 * cellH + 2;
        if (mx2 >= cx2 && mx2 <= cx2 + cellW - 4 && my2 >= cy2 && my2 <= cy2 + cellH - 4) {
          var val2 = dayTokens[day] || 0;
          showTooltip('heatmapTooltip', e, 'Day ' + day + ': ' + fmtNum(val2) + ' tokens');
          return;
        }
      }
    };
    canvas.onmouseleave = function() { hideTooltip('heatmapTooltip'); };
  }, 5);
}

// ---------- MONTH EXPORT ----------
function buildExportButton(parent) {
  var html = '<div style="text-align:center;margin-top:10px;">';
  html += '<button id="exportBtn" class="refresh-btn" style="font-size:11px;">Export Monthly Report (Markdown)</button>';
  html += '</div>';
  parent.innerHTML += html;

  setTimeout(function() {
    var btn = el('exportBtn');
    if (btn) {
      btn.addEventListener('click', function() {
        generateMonthlyReport();
      });
    }
  }, 5);
}

function generateMonthlyReport() {
  if (!lastClaudeData) { return; }
  var ds = lastClaudeData.dailyStats || [];
  var ym = currentYearMonth();
  var monthData = ds.filter(function(d) { return d.date.startsWith(ym); });
  var totalT = 0, totalC = 0, calls = 0;
  for (var i = 0; i < monthData.length; i++) {
    totalT += monthData[i].tokenStats.inputTokens + monthData[i].tokenStats.outputTokens + monthData[i].tokenStats.cacheReadTokens;
    totalC += monthData[i].cost || 0;
    calls += monthData[i].callCount || 0;
  }
  var dInM = daysInMonth();
  var elapsedMonthDays = elapsedCurrentMonthDays(new Date());
  var dailyAvg = elapsedMonthDays > 0 ? Math.round(totalT / elapsedMonthDays) : 0;
  var projected = computeProjection(totalT, elapsedMonthDays, dInM);

  var projects = lastClaudeData.topProjects || [];
  var models = lastClaudeData.modelUsage || [];

  var md = '# Monthly Usage Report - ' + ym + '\n\n';
  md += '## Summary\n';
  md += '- Total tokens: ' + fmtNum(totalT) + '\n';
  md += '- API calls: ' + fmtNum(calls) + '\n';
  md += '- Daily avg: ' + fmtNum(dailyAvg) + ' tok/day\n';
  md += '- Projected month: ' + fmtNum(projected) + ' tokens\n\n';
  md += '## Daily Trend\n';
  md += '| Date | Tokens | Calls |\n|------|--------|-------|\n';
  for (var i = 0; i < Math.min(monthData.length, 31); i++) {
    var d = monthData[i];
    var dt = d.tokenStats.inputTokens + d.tokenStats.outputTokens + d.tokenStats.cacheReadTokens;
    md += '| ' + d.date + ' | ' + fmtNum(dt) + ' | ' + d.callCount + ' |\n';
  }
  md += '\n## Project Ranking\n';
  md += '| Rank | Project | Tokens | Calls |\n|------|---------|--------|-------|\n';
  for (var i = 0; i < Math.min(projects.length, 5); i++) {
    var p = projects[i];
    var pt = p.tokenStats.inputTokens + p.tokenStats.outputTokens + p.tokenStats.cacheReadTokens;
    md += '| ' + (i + 1) + ' | ' + decodeProjectName(p.projectDir) + ' | ' + fmtNum(pt) + ' | ' + p.callCount + ' |\n';
  }
  md += '\n## Model Breakdown\n';
  md += '| Model | Tokens |\n|-------|--------|\n';
  for (var i = 0; i < Math.min(models.length, 5); i++) {
    var m = models[i];
    var mt = m.inputTokens + m.outputTokens + m.cacheReadTokens;
    md += '| ' + m.model + ' | ' + fmtNum(mt) + ' |\n';
  }

  // Copy to clipboard via VS Code
  vscode.postMessage({ command: 'copyReport', text: md });
}

// ---------- CUMULATIVE METRICS ----------
function buildCumulMetrics(data, parent) {
  var ds = data.dailyStats || [];
  var projects = data.topProjects || [];
  var firstDate = ds.length > 0 ? ds[0].date : '--';
  var totalMonths = 0;
  if (ds.length > 0) {
    var firstMonth = ds[0].date.slice(0, 7);
    var lastMonth = ds[ds.length - 1].date.slice(0, 7);
    totalMonths = (parseInt(lastMonth.slice(0,4)) - parseInt(firstMonth.slice(0,4))) * 12 + (parseInt(lastMonth.slice(5,7)) - parseInt(firstMonth.slice(5,7))) + 1;
  }
  var totalToks = data.tokenStats.inputTokens + data.tokenStats.outputTokens + data.tokenStats.cacheReadTokens;
  var avgMonthly = totalMonths > 0 ? Math.round(totalToks / totalMonths) : 0;

  // Peak month
  var monthMap = {};
  for (var i = 0; i < ds.length; i++) {
    var mk = ds[i].date.slice(0, 7);
    if (!monthMap[mk]) { monthMap[mk] = 0; }
    monthMap[mk] += ds[i].tokenStats.inputTokens + ds[i].tokenStats.outputTokens + ds[i].tokenStats.cacheReadTokens;
  }
  var peakMonth = '--', peakVal = 0;
  var months = Object.keys(monthMap);
  for (var i = 0; i < months.length; i++) {
    if (monthMap[months[i]] > peakVal) { peakVal = monthMap[months[i]]; peakMonth = months[i]; }
  }

  var html = '<div class="chart-container" style="padding:10px 14px;margin-top:10px;">';
  html += '<div class="chart-title" style="margin-bottom:8px;">Overall Metrics</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Total Projects</span><br><b>' + projects.length + '</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">First Usage Date</span><br><b>' + firstDate + '</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Avg Monthly Usage</span><br><b>' + fmtNum(avgMonthly) + ' tok</b></div>';
  html += '<div><span style="color:var(--vscode-descriptionForeground);">Peak Month</span><br><b>' + peakMonth + ' (' + fmtNum(peakVal) + ' tok)</b></div>';
  html += '</div></div>';
  parent.innerHTML += html;
}

window.addEventListener('message', function(event) {
  var msg = event.data;
  if (msg.command === 'update') {
    updateUI(msg);
  } else if (msg.command === 'error') {
    showError(msg.message);
  } else if (msg.command === 'refreshing') {
    isRefreshing = msg.active;
    var spinner = el('refreshSpinner');
    var btn = el('refreshBtn');
    if (spinner) { spinner.className = isRefreshing ? 'spinner active' : 'spinner'; }
    if (btn) { btn.disabled = isRefreshing; }
  } else if (msg.command === 'refreshHint') {
    var hint = el('refreshHint');
    if (hint) {
      hint.textContent = msg.message;
      hint.classList.add('visible');
      setTimeout(function() { hint.classList.remove('visible'); }, 3000);
    }
  } else if (msg.command === 'claudeUpdate') {
    renderClaudeModule(msg.data, msg.timestamp || Date.now());
  } else if (msg.command === 'config') {
    if (msg.lowBalanceThreshold !== undefined) { lowBalanceThreshold = msg.lowBalanceThreshold; }
    if (msg.lowDaysThreshold !== undefined) { lowDaysThreshold = msg.lowDaysThreshold; }
  } else if (msg.command === 'petStatus') {
    updatePetStatus(msg.status);
  }
});

el('refreshBtn').addEventListener('click', function() { vscode.postMessage({ command: 'refresh' }); });
var petBtn = el('petBtn');
if (petBtn) {
  petBtn.addEventListener('click', function() { vscode.postMessage({ command: 'petToggle' }); });
}
var petMenuBtn = el('petMenuBtn');
var petMenu = el('petMenu');
var petSelectBtn = el('petSelectBtn');
var petImportBtn = el('petImportBtn');
if (petMenuBtn && petMenu) {
  petMenuBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    petMenu.classList.toggle('open');
  });
  document.addEventListener('click', function(e) {
    if (!petMenu.contains(e.target) && e.target !== petMenuBtn) {
      petMenu.classList.remove('open');
    }
  });
}
if (petSelectBtn) {
  petSelectBtn.addEventListener('click', function() {
    if (petMenu) { petMenu.classList.remove('open'); }
    vscode.postMessage({ command: 'petSelect' });
  });
}
if (petImportBtn) {
  petImportBtn.addEventListener('click', function() {
    if (petMenu) { petMenu.classList.remove('open'); }
    vscode.postMessage({ command: 'petImport' });
  });
}

// Tab bar
var tabBar = el('claudeTabBar');
if (tabBar) {
  tabBar.addEventListener('click', function(e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) { return; }
    currentClaudeTab = btn.getAttribute('data-tab');
    var allBtns = tabBar.querySelectorAll('.tab-btn');
    for (var i = 0; i < allBtns.length; i++) { allBtns[i].classList.remove('active'); }
    btn.classList.add('active');
    if (lastClaudeData) { renderClaudeModule(lastClaudeData, Date.now()); }
  });
}

vscode.postMessage({ command: 'ready' });
