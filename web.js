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
  let input = null, descriptor = null, composing = false, deferredValue = null;
  let compositionResetTimer = null;
  const touchInput = () => matchMedia('(pointer: coarse)').matches;
  const send = (target, method, value) => unity?.SendMessage(target, method, value);
  const status = text => { $('save-status').textContent = text; };
  const error = text => { $('web-error').textContent = text; $('web-error').hidden = false; };

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
      } else error(failure.message || String(failure));
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
  function hideInput() {
    clearTimeout(compositionResetTimer);
    input?.remove(); input = null; descriptor = null; composing = false; deferredValue = null;
  }
  function publishInput() {
    // Ignore the old composition's final events after accepting a word.
    if (input && deferredValue !== null) { input.value = deferredValue; return; }
    if (input && descriptor) send('__HaedokWeb','OnInput',JSON.stringify({id:descriptor.id,value:input.value}));
  }
  function positionInput() {
    if (!input || !descriptor) return;
    const rect = $('unity-canvas').getBoundingClientRect(), d = descriptor;
    Object.assign(input.style, {left:rect.left + d.x*rect.width+'px',top:rect.top+d.y*rect.height+'px',
      width:d.width*rect.width+'px',height:d.height*rect.height+'px',fontSize:Math.max(16,d.fontSize*rect.height)+'px',color:d.color,background:d.background});
  }
  function showInput(d) {
    if (!input || descriptor?.id !== d.id) {
      hideInput(); input = document.createElement(d.multiline ? 'textarea' : 'input');
      input.className = 'native-input'; input.spellcheck = false; input.autocomplete = 'off';
      input.setAttribute('autocapitalize','off'); input.setAttribute('aria-label',d.typing ? '후리가나 또는 한자 입력' : (d.placeholder || '텍스트 입력'));
      input.value = d.value;
      input.addEventListener('compositionstart', () => {
        clearTimeout(compositionResetTimer);
        composing = true; deferredValue = null;
      });
      input.addEventListener('beforeinput', event => {
        // Some mobile keyboards start plain input instead of another composition.
        if (!composing && !event.isComposing && !/composition/i.test(event.inputType || '')) deferredValue = null;
      });
      input.addEventListener('input', publishInput);
      input.addEventListener('compositionend', () => {
        composing = false; publishInput();
        // A final input event can follow compositionend in the same browser task.
        if (deferredValue !== null) {
          const endedInput = input;
          compositionResetTimer = setTimeout(() => {
            if (input === endedInput) deferredValue = null;
          }, 0);
        }
      });
      document.body.appendChild(input);
    }
    descriptor = d; input.placeholder = d.placeholder; input.readOnly = d.readOnly;
    if (d.limit > 0) input.maxLength = d.limit; else input.removeAttribute('maxlength');
    positionInput();
    // On mobile a user tap may still be needed to open the software keyboard.
    if (!touchInput()) input.focus({preventScroll:true});
  }
  function setInputValue(value) {
    if (!input) return;
    if (composing) {
      if (touchInput()) {
        // Blurring a mobile input closes its keyboard; a timer cannot reliably reopen it.
        // Keep this same focused element and drain any remaining composition events.
        deferredValue = value;
      } else {
        input.blur(); composing = false; deferredValue = null;
      }
    }
    input.value = value;
    if (!touchInput()) input.focus({preventScroll:true});
  }
  window.addEventListener('keydown', event => {
    if ($('cloud-dialog').open) return;
    if (descriptor?.typing && ['F1','F2','F3'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) send('__HaedokWeb','OnShortcut',event.key);
    } else if (event.target === input) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('keyup', event => { if (event.target === input) event.stopImmediatePropagation(); }, true);
  window.addEventListener('resize',positionInput);
  window.visualViewport?.addEventListener('resize',positionInput);
  window.addEventListener('beforeunload', event => {
    if ((mode === 'local' && (pendingWrites || saveFailed)) || (mode === 'cloud' && window.HaedokCloud.pending())) { event.preventDefault(); event.returnValue = ''; }
  });
  $('start-trial').onclick = () => start('trial');
  $('start-local').onclick = () => start('local');
  $('google-login').onclick = () => start('cloud');
  $('sync-now').onclick = () => window.HaedokCloud.sync();
  $('sign-out').onclick = () => window.HaedokCloud.logout();
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
      send('__HaedokWeb','ImportBackup',text);
    } catch (failure) { error(failure.message); }
  };
  window.HaedokWeb = {
    readSave:() => json, isTrial:() => mode === 'trial', isDesktop:() => desktop, save, download, openCsv, showInput, setInputValue, hideInput, error,
    attach:instance => { unity = instance; if (ready) $('loading').hidden = true; },
    failed:message => {
      $('loading').querySelector('strong').textContent = '저장 기록을 확인해 주세요';
      $('loading').querySelector('p').textContent = message;
      $('progress').hidden = true; $('backup').disabled = !json; $('restore').disabled = false;
    },
    ready:() => { ready = true; $('loading').hidden = true; $('backup').disabled = false; $('restore').disabled = false; }
  };
  if (window.HaedokCloud?.shouldResume()) start('cloud');
})();
