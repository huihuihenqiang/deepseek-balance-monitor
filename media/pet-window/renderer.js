(function () {
  var params = new URLSearchParams(location.search);
  var port = params.get('port') || '';
  var token = params.get('token') || '';
  var base = 'http://127.0.0.1:' + port;

  var pet = document.getElementById('pet');
  var stage = document.getElementById('petStage');
  var bubble = document.getElementById('bubble');
  var chatPanel = document.getElementById('chatPanel');
  var chatToggle = document.getElementById('chatToggle');
  var chatForm = document.getElementById('chatForm');
  var chatInput = document.getElementById('chatInput');
  var sendBtn = document.getElementById('sendBtn');

  var COLS = 8;
  var ROWS = 9;
  var STATES = {
    idle: { row: 0, frames: [{ c: 0, d: 1680 }, { c: 1, d: 660 }, { c: 2, d: 660 }, { c: 3, d: 840 }, { c: 4, d: 840 }, { c: 5, d: 1920 }] },
    'running-right': { row: 1, count: 8, dur: 120, last: 220 },
    'running-left': { row: 2, count: 8, dur: 120, last: 220 },
    waving: { row: 3, count: 4, dur: 140, last: 280, loops: 1 },
    jumping: { row: 4, count: 5, dur: 140, last: 280 },
    failed: { row: 5, count: 8, dur: 140, last: 240 },
    waiting: { row: 6, count: 6, dur: 150, last: 260 },
    running: { row: 7, count: 6, dur: 120, last: 220 },
    review: { row: 8, count: 6, dur: 150, last: 280 }
  };

  var currentState = '';
  var stateTimer = null;
  var pollTimer = null;
  var bubbleTimer = null;
  var chatOpen = false;
  var lastDragMoveSentAt = 0;
  var tapTimer = null;
  var lastAnimationUpdateAt = 0;
  var clickThrough = null;

  function api(path) {
    return base + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
  }

  function postJson(path, body) {
    return fetch(api(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ai-usage-pet-token': token
      },
      body: body ? JSON.stringify(body) : '{}'
    }).then(function (r) { return r.json(); });
  }

  function postEmpty(path) {
    return fetch(api(path), {
      method: 'POST',
      headers: {
        'x-ai-usage-pet-token': token
      }
    });
  }

  function buildFrames(def) {
    if (def.frames) {
      return def.frames.map(function (f) { return { c: f.c, r: def.row, d: f.d }; });
    }
    var frames = [];
    for (var i = 0; i < def.count; i++) {
      frames.push({ c: i, r: def.row, d: i === def.count - 1 ? def.last : def.dur });
    }
    return frames;
  }

  function pos(c, r) {
    return (c / (COLS - 1) * 100) + '% ' + (r / (ROWS - 1) * 100) + '%';
  }

  function play(state, force) {
    state = STATES[state] ? state : 'idle';
    if (!force && state === currentState) {
      return;
    }
    currentState = state;
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    var frames = buildFrames(STATES[state]);
    var i = 0;
    pet.style.backgroundPosition = pos(frames[0].c, frames[0].r);
    var loops = 0;
    var maxLoops = STATES[state].loops || 0;
    function tick() {
      stateTimer = setTimeout(function () {
        if (i === frames.length - 1) {
          loops++;
          if (maxLoops && loops >= maxLoops) {
            stateTimer = null;
            return;
          }
        }
        i = (i + 1) % frames.length;
        pet.style.backgroundPosition = pos(frames[i].c, frames[i].r);
        tick();
      }, frames[i].d);
    }
    if (frames.length > 1) {
      tick();
    }
  }

  function clearBubble() {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    bubble.className = '';
    bubble.textContent = '';
  }

  function showBubble(data, persist) {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    if (!data || !data.text) {
      return;
    }
    bubble.textContent = data.text;
    bubble.className = 'visible ' + (data.tone || 'neutral');
    if (persist || chatOpen) {
      return;
    }
    bubbleTimer = setTimeout(function () {
      clearBubble();
    }, 7000);
  }

  function setChatBusy(busy) {
    sendBtn.disabled = busy;
    chatInput.disabled = busy;
  }

  function setClickThrough(ignore) {
    if (clickThrough === ignore || !window.petWindow || !window.petWindow.setClickThrough) {
      return;
    }
    clickThrough = ignore;
    window.petWindow.setClickThrough(ignore);
  }

  function updateClickThrough(e) {
    if (pointer) {
      setClickThrough(false);
      return;
    }
    var target = e && e.target;
    var interactive = !!(target && target.closest && target.closest('#pet, #chatToggle, #chatPanel'));
    setClickThrough(!interactive);
  }

  function applyUpdate(update) {
    if (!update) {
      return;
    }
    var updatedAt = update.updatedAt || 0;
    var forceReplay = updatedAt && updatedAt !== lastAnimationUpdateAt;
    lastAnimationUpdateAt = updatedAt || lastAnimationUpdateAt;
    play(update.state || 'idle', forceReplay);
    showBubble(update.bubble);
  }

  function connectEvents() {
    var source = new EventSource(api('/events'));
    source.onmessage = function (event) {
      try {
        applyUpdate(JSON.parse(event.data));
      } catch (_err) {
        // ignore malformed server-sent events
      }
    };
    source.onerror = function () {
      if (!pollTimer) {
        pollTimer = setInterval(fetchState, 3000);
      }
    };
  }

  function fetchState() {
    fetch(api('/state'))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(applyUpdate)
      .catch(function () {});
  }

  function sendInteraction(type, direction) {
    postJson('/interaction', {
      type: type,
      direction: direction || 'center'
    }).catch(function () {});
  }

  function directionFromDelta(dx) {
    if (dx < -3) {
      return 'left';
    }
    if (dx > 3) {
      return 'right';
    }
    return 'center';
  }

  chatToggle.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
  });

  chatToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    if (chatOpen) {
      postEmpty('/chat/close').catch(function () {});
      chatOpen = false;
      chatPanel.classList.remove('open');
      clearBubble();
      sendInteraction('chat-close', 'center');
      return;
    }
    postEmpty('/chat/open')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        chatOpen = true;
        chatPanel.classList.add('open');
        if (data && data.reply) {
          showBubble({ text: data.reply, tone: 'neutral' }, true);
        }
        setClickThrough(false);
        sendInteraction('chat-open', 'center');
        chatInput.focus();
      })
      .catch(function () {});
  });

  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = chatInput.value.trim();
    if (!text) {
      return;
    }
    chatInput.value = '';
    setChatBusy(true);
    postJson('/chat', { message: text })
      .then(function (data) {
        showBubble({
          text: data.ok ? data.reply : (data.error || 'Chat failed'),
          tone: data.ok ? 'ok' : 'danger'
        }, true);
      })
      .catch(function (err) {
        showBubble({ text: 'Chat failed: ' + err.message, tone: 'danger' }, true);
      })
      .finally(function () {
        setChatBusy(false);
        chatInput.focus();
      });
  });

  var pointer = null;
  var longPressTimer = null;
  var longPressFired = false;
  var dragStarted = false;
  var lastTapAt = 0;

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  stage.addEventListener('pointermove', function (e) {
    if (!pointer || e.pointerId !== pointer.id) {
      return;
    }
    var dx = e.screenX - pointer.startX;
    var dy = e.screenY - pointer.startY;
    var distance = Math.sqrt(dx * dx + dy * dy);
    var dir = directionFromDelta(dx);
    if (distance > 8) {
      pointer.moved = true;
      clearLongPress();
    }
    if (!pointer.moved) {
      return;
    }
    if (!dragStarted) {
      dragStarted = true;
      sendInteraction('drag-start', dir);
    }
    if (Date.now() - lastDragMoveSentAt > 240) {
      sendInteraction('drag-move', dir);
      lastDragMoveSentAt = Date.now();
    }
    if (!longPressFired) {
      window.petWindow.dragMove({ screenX: e.screenX, screenY: e.screenY });
    }
  });

  stage.addEventListener('pointerdown', function (e) {
    if (e.target === chatToggle || chatPanel.contains(e.target)) {
      return;
    }
    setClickThrough(false);
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
    pointer = {
      id: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      moved: false
    };
    dragStarted = false;
    longPressFired = false;
    lastDragMoveSentAt = 0;
    window.petWindow.dragStart({ screenX: e.screenX, screenY: e.screenY });
    sendInteraction('hold-start', 'center');
    longPressTimer = setTimeout(function () {
      if (pointer && !pointer.moved) {
        longPressFired = true;
        sendInteraction('hold-complete', 'center');
        postEmpty('/long-press').catch(function () {});
      }
    }, 3000);
  });

  function finishPointer(e) {
    if (!pointer || e.pointerId !== pointer.id) {
      return;
    }
    clearLongPress();
    var wasMoved = pointer.moved;
    stage.classList.remove('dragging');
    window.petWindow.dragEnd();
    pointer = null;
    if (dragStarted) {
      dragStarted = false;
      sendInteraction('drag-end', 'center');
      return;
    }
    if (longPressFired || wasMoved) {
      return;
    }
    var now = Date.now();
    if (now - lastTapAt < 320) {
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
      }
      lastTapAt = 0;
      sendInteraction('double-tap', 'center');
      return;
    }
    lastTapAt = now;
    tapTimer = setTimeout(function () {
      tapTimer = null;
      if (Date.now() - lastTapAt >= 300) {
        sendInteraction('tap', 'center');
      }
    }, 320);
  }

  stage.addEventListener('pointerup', finishPointer);
  stage.addEventListener('pointercancel', finishPointer);
  stage.addEventListener('pointerleave', function (e) {
    if (pointer && e.pointerId === pointer.id && pointer.moved) {
      finishPointer(e);
    }
  });

  document.addEventListener('mousemove', updateClickThrough);
  document.addEventListener('mouseleave', function () {
    if (!pointer) {
      setClickThrough(true);
    }
  });

  function bootstrapAsset() {
    fetch(api('/asset/spritesheet'))
      .then(function (r) {
        if (!r.ok) {
          throw new Error('asset_missing');
        }
        pet.style.backgroundImage = 'url("' + api('/asset/spritesheet') + '")';
        setClickThrough(true);
        play('idle');
        fetchState();
        connectEvents();
      })
      .catch(function () {
        showBubble({ text: 'Pet asset failed to load', tone: 'danger' });
      });
  }

  bootstrapAsset();
})();
