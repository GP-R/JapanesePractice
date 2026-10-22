/* Browser-only integration. Learning screens and their visual design remain Unity prefabs. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  // Choose once per session so resizing never resets a study session or an unfinished form.
  const desktop = !(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
    matchMedia('(min-width: 960px) and (pointer: fine)').matches;
  document.documentElement.classList.toggle('desktop', desktop);
  let mode = null, db = null, json = '', previous = '', unity = null, ready = false;
  let writeQueue = Promise.resolve(), pendingWrites = 0, saveFailed = false, releaseLock;
  const inputFields = new Map();
  const touchInput = () => matchMedia('(pointer: coarse)').matches;
  const send = (target, method, value) => unity?.SendMessage(target, method, value);
  const status = text => { $('save-status').textContent = text; };
  const error = text => { $('web-error').textContent = text; $('web-error').hidden = false; };
  const modalOpen = () => $('about-dialog').open || $('cloud-dialog').open;
  function showAbout() {
    for (const {element} of inputFields.values()) element.hidden = true;
    if (!$('about-dialog').open) $('about-dialog').showModal();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('haedok-web-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('saves');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('브라우저 저장소를 열지 못했어요. 저장 없이 체험하기를 이용할 수 있어요.'));
      request.onblocked = () => reject(new Error('다른 회독 탭을 닫고 다시 시도해 주세요.'));
    });
  }
  function readRecord(key = 'local') {
    return new Promise((resolve, reject) => {
      const request = db.transaction('saves').objectStore('saves').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function putRecord(record, key = 'local') {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('saves', 'readwrite');
      transaction.objectStore('saves').put(record, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('저장이 중단됐어요.'));
    });
  }
  async function lockLocalSave(key = 'haedok-local-save') {
    if (!navigator.locks) throw new Error('이 브라우저에서는 안전한 저장 모드를 지원하지 않아요. 최신 브라우저나 저장 없이 체험하기를 이용해 주세요.');
    await new Promise((resolve, reject) => {
      navigator.locks.request(key, {ifAvailable:true}, lock => {
        if (!lock) { reject(new Error('다른 탭에서 저장 모드를 사용 중이에요. 그 탭을 닫아 주세요.')); return; }
        resolve();
        return new Promise(release => { releaseLock = release; });
      }).catch(reject);
    });
  }
  async function start(selectedMode) {
    if (mode) return;
    for (const id of ['start-trial','start-local','google-login']) $(id).disabled = true;
    $('welcome-error').textContent = '';
    try {
      if (selectedMode === 'local') {
        await lockLocalSave(); db = await openDatabase();
        const record = await readRecord(); json = record?.json || ''; previous = record?.previous || '';
      } else if (selectedMode === 'cloud') {
        const record = await window.HaedokCloud.begin({
          open: async () => { db = await openDatabase(); },
          lock: lockLocalSave, readRecord, putRecord, status, error, download
        });
        if (!record) return; // The browser is navigating to Google.
        json = record.json; previous = record.previous;
      } else { json = ''; previous = ''; } // Trial never reads or writes persistent study data.
      mode = selectedMode;
      $('welcome').hidden = true; $('app').hidden = false;
      status(mode === 'trial' ? '체험 중 · 저장 안 함' : mode === 'cloud' ? '계정 기록 불러옴' : '이 브라우저에 저장');
      await window.HaedokLaunch();
      if (mode === 'cloud') window.HaedokCloud.sync();
    } catch (failure) {
      if (!mode) {
        releaseLock?.(); db?.close(); db = null;
        $('welcome-error').textContent = failure.message;
        for (const id of ['start-trial','start-local','google-login']) $(id).disabled = false;
      } else {
        error(failure.message || String(failure));
        $('recovery-about').hidden = false;
        $('backup').disabled = !json;
      }
    }
  }
  function save(value) {
    if (json === value) return;
    const old = json; json = value;
    if (mode === 'trial') return;
    if (mode === 'cloud') { window.HaedokCloud.save(value); return; }
    if (mode !== 'local' || !db) throw new Error('저장 모드가 준비되지 않았어요.');
    pendingWrites++; status('브라우저에 저장 중…');
    writeQueue = writeQueue.then(async () => {
      await putRecord({json:value, previous:old || previous, updatedAt:new Date().toISOString()});
      previous = old || previous; saveFailed = false;
    }).catch(() => {
      saveFailed = true;
      error('브라우저에 저장하지 못했어요. 저장 공간과 권한을 확인하고, 백업 저장으로 현재 기록을 보관해 주세요.');
    }).finally(() => {
      pendingWrites--;
      if (!pendingWrites) status(saveFailed ? '저장 실패 · 백업 필요' : '이 브라우저에 저장 완료');
    });
  }
  function download(name, contents, mime) {
    const url = URL.createObjectURL(new Blob([contents], {type:mime}));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const base64 = bytes => {
    let result = ''; for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(result);
  };
  function openCsv(receiver, token) {
    const picker = $('csv-upload'); picker.value = '';
    const respond = value => send(receiver, 'OnCsvFilePicked', token + '|' + value);
    picker.oncancel = () => respond('cancel');
    picker.onchange = async () => {
      try {
        const file = picker.files[0]; if (!file) { respond('cancel'); return; }
        if (file.size > 4 * 1024 * 1024) throw new Error('CSV 파일은 4 MB 이하로 선택해 주세요.');
        respond('ok|' + base64(new TextEncoder().encode(file.name)) + '|' + base64(new Uint8Array(await file.arrayBuffer())));
      } catch (failure) { respond('error|' + base64(new TextEncoder().encode(failure.message))); }
    };
    picker.click();
  }
  function positionInputs() {
    const canvas = $('unity-canvas'), width = canvas.clientWidth, height = canvas.clientHeight;
    for (const {element, descriptor:d} of inputFields.values()) {
      Object.assign(element.style, {
        left:canvas.offsetLeft+d.x*width+'px', top:canvas.offsetTop+d.y*height+'px',
        width:d.width*width+'px', height:d.height*height+'px',
        fontSize:Math.max(16,d.fontSize*height)+'px', color:d.color, background:d.background,
        clipPath:d.clipTop||d.clipRight||d.clipBottom||d.clipLeft
          ? `inset(${(d.clipTop||0)*100}% ${(d.clipRight||0)*100}% ${(d.clipBottom||0)*100}% ${(d.clipLeft||0)*100}%)` : 'none'
      });
    }
  }
  function keyboardViewport() {
    const viewport = window.visualViewport;
    // Safari pans the visual viewport as well as shrinking it. A height-only fix
    // puts part of the canvas above the visible page and leaves a blank strip below.
    const top = viewport ? Math.max(0, viewport.offsetTop, viewport.pageTop - window.scrollY) : 0;
    const reduced = touchInput() && viewport && (viewport.height < window.innerHeight - 80 || top > 1);
    $('app').style.setProperty('--keyboard-height', (viewport?.height || window.innerHeight)+'px');
    $('app').style.setProperty('--keyboard-top', top+'px');
    $('app').classList.toggle('keyboard-open', Boolean(reduced));
    positionInputs();
  }
  function createNativeInput(record, value) {
    const d = record.descriptor;
    const element = document.createElement(d.multiline ? 'textarea' : 'input');
    element.className = 'native-input'; element.spellcheck = false; element.autocomplete = 'off';
    element.setAttribute('autocapitalize','off');
    element.value = value; // Initialize before focus, when this field has no IME composition.
    element.addEventListener('compositionstart', () => {
      if (record.element === element) record.composing = true;
    });
    element.addEventListener('compositionend', () => {
      if (record.element === element) record.composing = false;
    });
    element.addEventListener('input', event => {
      // A retired field may emit its final composition event during the focus handoff.
      if (record.element !== element) return;
      if (event.isComposing) record.composing = true;
      send('__HaedokWeb','OnInput',JSON.stringify({id:record.descriptor.id,value:element.value}));
    });
    element.addEventListener('focus', keyboardViewport);
    element.addEventListener('blur', keyboardViewport);
    return element;
  }
  function configureNativeInput(record) {
    const {element, descriptor:d} = record;
    element.setAttribute('aria-label',d.typing ? '후리가나 또는 한자 입력' : (d.placeholder || '텍스트 입력'));
    element.placeholder = d.placeholder; element.readOnly = d.readOnly;
    element.hidden = modalOpen();
    if (d.limit > 0) element.maxLength = d.limit; else element.removeAttribute('maxlength');
  }
  function syncInputs(snapshot) {
    const visible = new Set(snapshot.fields.map(d => d.id));
    for (const [id, record] of inputFields) {
      if (!visible.has(id)) { record.element.remove(); inputFields.delete(id); }
    }
    for (const d of snapshot.fields) {
      let record = inputFields.get(d.id);
      const created = !record;
      if (created) {
        record = {element:null, descriptor:d, composing:false}; inputFields.set(d.id, record);
        record.element = createNativeInput(record, d.value);
        $('player-area').appendChild(record.element);
      }
      record.descriptor = d;
      if (record.element.value !== d.value && record.composing) {
        // Never overwrite a live IME composition: iOS can stop accepting text and
        // desktop IMEs can resurrect the previous answer. Keep the keyboard session
        // by focusing the new field while the old field is still attached and focused.
        const previous = record.element, focused = document.activeElement === previous;
        record.element = createNativeInput(record, d.value);
        record.composing = false;
        record.element.style.cssText = previous.style.cssText;
        configureNativeInput(record);
        $('player-area').appendChild(record.element);
        if (focused && !record.element.hidden && !d.readOnly) record.element.focus({preventScroll:true});
        previous.remove();
      } else if (record.element.value !== d.value) record.element.value = d.value;
      configureNativeInput(record);
      // Desktop typing starts focused. Touch screens use the real, already-present input.
      if (created && d.typing && !touchInput() && !modalOpen()) record.element.focus({preventScroll:true});
    }
    keyboardViewport();
  }
  window.addEventListener('pointerdown', event => {
    const active = document.activeElement;
    if (active?.classList.contains('native-input') && event.target !== active) active.blur();
  }, true);
  window.addEventListener('keydown', event => {
    const shortcut = ['F1','F2','F3','F4'].includes(event.key);
    if (modalOpen()) {
      if (shortcut) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (shortcut && [...inputFields.values()].some(record => record.descriptor.typing)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) send('__HaedokWeb','OnShortcut',event.key);
    } else if (event.target.classList?.contains('native-input')) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('keyup', event => {
    if (event.target.classList?.contains('native-input')) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('resize',keyboardViewport);
  window.addEventListener('scroll',keyboardViewport,{passive:true});
  window.visualViewport?.addEventListener('resize',keyboardViewport);
  window.visualViewport?.addEventListener('scroll',keyboardViewport,{passive:true});
  new ResizeObserver(positionInputs).observe($('unity-canvas'));
  window.addEventListener('beforeunload', event => {
    if ((mode === 'local' && (pendingWrites || saveFailed)) || (mode === 'cloud' && window.HaedokCloud.pending())) { event.preventDefault(); event.returnValue = ''; }
  });
  $('start-trial').onclick = () => start('trial');
  $('start-local').onclick = () => start('local');
  $('google-login').onclick = () => start('cloud');
  $('sync-now').onclick = () => window.HaedokCloud.sync();
  $('sign-out').onclick = () => window.HaedokCloud.logout();
  $('about-close').onclick = () => $('about-dialog').close();
  for (const id of ['about-dialog','cloud-dialog']) $(id).addEventListener('close', () => {
    for (const {element} of inputFields.values()) element.hidden = modalOpen();
  });
  $('about-guide').onclick = () => { $('about-dialog').close(); send('__HaedokWeb','ShowGuide',''); };
  $('recovery-about').onclick = showAbout;
  $('home').onclick = async () => {
    if (mode === 'cloud') {
      await window.HaedokCloud.sync();
      if (window.HaedokCloud.pending() && !confirm('서버 저장 대기 중인 기록이 있어요. 이 기기 기록을 남겨 두고 시작 화면으로 돌아갈까요?')) return;
    }
    await writeQueue;
    if (saveFailed && !confirm('저장하지 못한 기록이 있어요. 백업 없이 시작 화면으로 돌아갈까요?')) return;
    location.reload();
  };
  $('backup').onclick = () => download('회독_백업_' + new Date().toISOString().slice(0,10) + '.json',json,'application/json;charset=utf-8');
  $('restore').onclick = () => { $('backup-upload').value = ''; $('backup-upload').click(); };
  $('backup-upload').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const text = await file.text(); const data = JSON.parse(text);
      if (data.schemaVersion !== 1 || !Array.isArray(data.decks) || !Array.isArray(data.folders)) throw new Error('회독 앱의 JSON 백업 파일이 아니에요.');
      if (!confirm('현재 단어장과 진도를 이 백업으로 바꿀까요? 현재 기록이 필요하면 먼저 백업 저장을 해주세요.')) return;
      $('about-dialog').close();
      send('__HaedokWeb','ImportBackup',text);
    } catch (failure) { error(failure.message); }
  };
  window.HaedokWeb = {
    readSave:() => json, isTrial:() => mode === 'trial', isDesktop:() => desktop, save, download, openCsv, syncInputs, showAbout, error,
    attach:instance => { unity = instance; if (ready) $('loading').hidden = true; },
    failed:message => {
      $('loading').querySelector('strong').textContent = '저장 기록을 확인해 주세요';
      $('loading').querySelector('p').textContent = message;
      $('progress').hidden = true; $('backup').disabled = !json; $('restore').disabled = false;
      $('recovery-about').hidden = false;
    },
    ready:() => { ready = true; $('loading').hidden = true; $('backup').disabled = false; $('restore').disabled = false; }
  };
  if (window.HaedokCloud?.shouldResume()) start('cloud');
})();
