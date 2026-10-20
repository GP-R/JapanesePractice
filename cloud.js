/* Account storage and synchronization. No secrets belong in this file or its config. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const resumeKey = 'haedok-cloud-resume';
  let client, hooks, user, state, busy, timer, poll, active = false, conflict = false;
  let localQueue = Promise.resolve(), diskFailed = false, authLost = false;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const accountKey = () => 'account:' + user.id;

  function validateLibrary(json) {
    const data = JSON.parse(json);
    if (data.schemaVersion !== 1 || !Array.isArray(data.decks) || !Array.isArray(data.folders) ||
        !data.folders.some(f => f?.id === 'root')) throw new Error('저장된 단어장 형식을 확인할 수 없어요. 백업을 보관한 후 문의해 주세요.');
    return data;
  }
  // Large word lists only travel when edited. Each deck's two progress records are separate.
  function pack(json) {
    const data = validateLibrary(json);
    const { decks, ...meta } = data;
    const records = { library: { ...meta, deckIds: decks.map(d => d.id) } };
    for (const deck of decks) {
      const { progress, favoriteProgress, ...content } = deck;
      records['deck:' + deck.id] = content;
      records['progress:' + deck.id] = progress || {};
      records['favorites:' + deck.id] = favoriteProgress || {};
    }
    return records;
  }
  function unpack(records) {
    if (!Object.keys(records).length) return '';
    if (!records.library || !Array.isArray(records.library.deckIds)) throw new Error('서버 저장 형식이 올바르지 않아요.');
    const { deckIds, ...meta } = records.library;
    const json = JSON.stringify({ ...meta, decks: deckIds.map(id => {
      const deck = records['deck:' + id];
      if (!deck || deck.id !== id) throw new Error('서버 단어장 일부가 없어요.');
      return { ...deck, progress: records['progress:' + id] || {}, favoriteProgress: records['favorites:' + id] || {} };
    }) });
    validateLibrary(json);
    return json;
  }
  function dirty() { return !!state?.json && !same(pack(state.json), state.base); }
  function persist() {
    // Take the snapshot inside the queue, never let an older write overwrite a newer revision.
    localQueue = localQueue.catch(() => {}).then(async () => {
      await hooks.putRecord({ ...state, updatedAt: new Date().toISOString() }, accountKey());
      diskFailed = false;
    }).catch(failure => { diskFailed = true; throw failure; });
    return localQueue;
  }
  function message(text) { hooks.status(text); }
  function choose(title, description, choices) {
    const dialog = $('cloud-dialog');
    $('cloud-title').textContent = title;
    $('cloud-description').textContent = description;
    const actions = $('cloud-actions'); actions.replaceChildren();
    return new Promise(resolve => {
      for (const choice of choices) {
        const button = document.createElement('button');
        button.textContent = choice.label; button.className = choice.primary ? 'primary' : '';
        button.onclick = () => {
          if (choice.run) { choice.run(); return; }
          dialog.close(); resolve(choice.value);
        };
        actions.appendChild(button);
      }
      dialog.oncancel = event => event.preventDefault();
      dialog.showModal();
    });
  }
  async function initialize() {
    if (client) return;
    const response = await fetch('supabase-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('로그인 설정 파일을 읽지 못했어요.');
    const config = await response.json();
    if (!config.enabled || !config.publishableKey?.startsWith('sb_publishable_')) throw new Error('공개 로그인 설정을 확인해 주세요.');
    const redirect = new URL(config.redirectUrl);
    if (redirect.origin !== location.origin || redirect.pathname !== location.pathname)
      throw new Error('로그인 주소가 현재 사이트와 달라요. 배포 주소에 맞게 supabase-config.json과 Supabase Redirect URLs를 설정해 주세요.');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'vendor/supabase.js';
      script.onload = resolve; script.onerror = () => reject(new Error('로그인 모듈을 읽지 못했어요.'));
      document.head.appendChild(script);
    });
    client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
      global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) }) }
    });
    client.haedokRedirect = redirect.href;
    client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (!session || session.user.id !== user.id) {
        authLost = true;
        message('로그인이 만료됐어요 · 이 기기에 보관 중');
      }
    });
  }
  async function fetchRow(columns) {
    const { data: session, error: sessionError } = await client.auth.getSession();
    if (sessionError || session.session?.user.id !== user.id) throw new Error('계정이 변경됐어요. 다시 로그인해 주세요.');
    const { data, error } = await client.from('haedok_saves').select(columns)
      .eq('user_id', user.id).setHeader('Authorization', 'Bearer ' + session.session.access_token).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function remote() {
    const data = await fetchRow('revision,records,updated_at');
    const row = data || { revision: 0, records: {} };
    unpack(row.records); // Refuse to replace a good cache with unreadable server data.
    return row;
  }
  function backup(name, json) {
    if (json) hooks.download('회독_' + name + '_' + new Date().toISOString().slice(0, 10) + '.json', json, 'application/json;charset=utf-8');
  }
  async function resolveConflict(row, beforeLaunch = false) {
    conflict = true;
    message('다른 기기 기록과 확인 필요');
    const serverJson = unpack(row.records);
    const selection = await choose('어느 기록으로 이어갈까요?',
      '다른 기기에서 저장한 기록이 있어요. 두 기록은 자동으로 합쳐지지 않아요. 필요하면 각각 백업한 뒤 선택해 주세요.', [
        { label: '서버 기록으로 이어가기', value: 'server', primary: true },
        { label: '현재 기기 기록을 서버에 저장', value: 'device' },
        { label: '현재 기기 기록 백업', run: () => backup('현재기기', state.json) },
        { label: '서버 기록 백업', run: () => backup('서버', serverJson) }
      ]);
    state.base = row.records; state.revision = row.revision;
    if (selection === 'server') {
      state.previous = state.json;
      state.json = serverJson;
    }
    try { await persist(); } finally { conflict = false; }
    if (selection === 'server' && !beforeLaunch) {
      active = false;
      sessionStorage.setItem(resumeKey, '1');
      location.reload(); // Recreate Unity safely instead of replacing a running study coroutine.
      return false;
    }
    return true;
  }
  async function begin(callbacks) {
    hooks = callbacks;
    await initialize();
    const url = new URL(location.href);
    const oauthError = url.searchParams.get('error_description') || new URLSearchParams(url.hash.slice(1)).get('error_description');
    const code = url.searchParams.get('code');
    if (oauthError || code) {
      url.searchParams.delete('code'); url.searchParams.delete('error'); url.searchParams.delete('error_description'); url.searchParams.delete('error_code');
      url.hash = ''; history.replaceState(null, '', url);
      if (oauthError) throw new Error('Google 로그인을 완료하지 못했어요. 다시 로그인해 주세요.');
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) throw new Error('로그인 연결이 만료됐어요. 같은 브라우저에서 다시 로그인해 주세요.');
    }
    sessionStorage.removeItem(resumeKey);
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (!sessionData.session) {
      sessionStorage.setItem(resumeKey, '1');
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
        redirectTo: client.haedokRedirect, queryParams: { prompt: 'select_account' }
      } });
      if (error) { sessionStorage.removeItem(resumeKey); throw error; }
      return null;
    }
    const { data: verified, error: verifyError } = await client.auth.getUser();
    if (verifyError || !verified.user) throw new Error('로그인을 확인하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
    user = verified.user;
    await hooks.lock('haedok-account-' + user.id);
    await hooks.open();
    const cached = await hooks.readRecord(accountKey());
    const row = await remote();
    state = { revision: row.revision, base: row.records, json: unpack(row.records), previous: '' };
    if (cached?.json) {
      validateLibrary(cached.json);
      if (!same(pack(cached.json), cached.base || {})) {
        state = cached;
        if (cached.revision !== row.revision) await resolveConflict(row, true);
      }
    }
    if (!state.json) {
      const local = await hooks.readRecord('local');
      if (local?.json) {
        const selection = await choose('계정의 첫 단어장을 준비해요',
          '이 브라우저에 저장한 단어장과 진도를 계정에 복사할까요? 기존 브라우저 기록은 그대로 남아요.', [
            { label: '브라우저 기록을 계정에 복사', value: 'import', primary: true },
            { label: '기본 단어장으로 새로 시작', value: 'new' }
          ]);
        if (selection === 'import') { validateLibrary(local.json); state.json = local.json; }
      }
    }
    await persist();
    active = true; authLost = false;
    $('account-name').textContent = user.email || 'Google 계정';
    $('account-controls').hidden = false;
    message('계정 기록 불러옴');
    poll = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);
    window.addEventListener('online', sync);
    return { json: state.json, previous: state.previous || '' };
  }
  function save(json) {
    if (!active || json === state.json) return;
    validateLibrary(json);
    state.previous = state.json || state.previous; state.json = json;
    message('이 기기에 보관 중…');
    persist().then(() => {
      if (!conflict) message('이 기기에 보관됨 · 서버 저장 대기');
      clearTimeout(timer); timer = setTimeout(sync, 1000);
    }).catch(() => { message('기기 저장 실패 · 백업 필요'); hooks.error('이 기기에 기록을 보관하지 못했어요. 백업 저장을 눌러 기록을 보관해 주세요.'); });
  }
  async function sync() {
    if (!active || conflict) return false;
    if (busy) return busy;
    clearTimeout(timer);
    busy = (async () => {
      try {
        await persist();
        if (authLost) throw new Error('로그인이 만료됐어요. 백업 후 시작 화면에서 다시 로그인해 주세요.');
        // Verify the session owner before every write, including a sign-in from another tab.
        const { data, error } = await client.auth.getSession();
        if (error || data.session?.user.id !== user.id) throw new Error('계정이 변경됐어요. 백업 후 다시 로그인해 주세요.');
        message('서버와 동기화 중…');
        // Most checks need only a version number, not thousands of words.
        const head = await fetchRow('revision');
        if ((head?.revision || 0) !== state.revision) {
          if (!await resolveConflict(await remote())) return false;
        }
        // A change made while the request runs remains dirty and gets a subsequent write.
        if (dirty()) {
          const next = pack(state.json), changed = {}, deleted = [];
          for (const [key, value] of Object.entries(next)) if (!same(value, state.base[key])) changed[key] = value;
          for (const key of Object.keys(state.base)) if (!(key in next)) deleted.push(key);
          const { data: result, error: saveError } = await client.rpc('haedok_save_changes', {
            expected_revision: state.revision, changed_records: changed, deleted_keys: deleted
          }).setHeader('Authorization', 'Bearer ' + data.session.access_token);
          if (saveError) {
            if (saveError.code === '40001') {
              await resolveConflict(await remote());
              if (active) timer = setTimeout(sync, 0);
              return false;
            }
            throw saveError;
          }
          state.base = next; state.revision = result[0].revision;
          await persist();
        }
        if (dirty()) { timer = setTimeout(sync, 500); message('다음 변경 저장 대기'); return false; }
        message('서버에 저장 완료');
        $('cloud-error').hidden = true;
        return true;
      } catch (failure) {
        message(diskFailed ? '기기 저장 실패 · 백업 필요' : '동기화 대기 · 이 기기에 보관');
        $('cloud-error').textContent = '서버와 연결하지 못했어요. 인터넷과 로그인 상태를 확인한 뒤 ‘동기화’를 눌러 주세요. ' +
          (failure.code === '42501' || failure.code === 'PGRST202' ? 'Supabase SQL 설정도 확인해 주세요.' : '');
        $('cloud-error').hidden = false;
        return false;
      } finally { busy = null; }
    })();
    return busy;
  }
  async function logout() {
    if (conflict) return;
    await sync();
    if (!active) return;
    if (dirty() || diskFailed) {
      const selection = await choose('아직 서버에 저장하지 못했어요',
        '이 계정의 기기 기록은 남겨 두며, 같은 브라우저에서 다시 로그인하면 이어서 저장할 수 있어요. 기기 저장도 실패했다면 먼저 백업해 주세요.', [
          { label: '돌아가기', value: 'cancel', primary: true },
          { label: '현재 기록 백업', run: () => backup('로그아웃전', state.json) },
          { label: '로그아웃', value: 'logout' }
        ]);
      if (selection === 'cancel') return;
    }
    active = false; clearInterval(poll); clearTimeout(timer);
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) { active = true; hooks.error('로그아웃하지 못했어요. 연결을 확인하고 다시 시도해 주세요.'); return; }
    sessionStorage.removeItem(resumeKey); location.reload();
  }
  window.HaedokCloud = {
    begin, save, sync, logout,
    pending: () => active && (dirty() || diskFailed || !!busy),
    shouldResume: () => new URL(location.href).searchParams.has('code') ||
      new URL(location.href).searchParams.has('error') ||
      new URLSearchParams(location.hash.slice(1)).has('error') || sessionStorage.getItem(resumeKey) === '1'
  };
})();
