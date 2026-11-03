/* Opt-in local diagnostics: ?inputDebug=1. Records geometry and event types, never typed text or saves. */
(() => {
  'use strict';
  if (new URLSearchParams(location.search).get('inputDebug') !== '1') return;
  const $ = id => document.getElementById(id);
  const samples = [], ids = new WeakMap(), compositions = new WeakSet(), started = performance.now();
  let nextId = 0, frame = 0, pending = [], lastFocused = null;
  const number = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  const rect = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {x:number(r.x),y:number(r.y),w:number(r.width),h:number(r.height),bottom:number(r.bottom)};
  };
  function identify(element) {
    if (!element) return null;
    if (!ids.has(element)) ids.set(element, ++nextId);
    return ids.get(element);
  }
  function layout(element) {
    const style = getComputedStyle(element);
    return {...rect(element),height:style.height,overflow:style.overflow,
      scrollTop:number(element.scrollTop),scrollLeft:number(element.scrollLeft),
      scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,
      clientWidth:element.clientWidth,clientHeight:element.clientHeight};
  }
  function capture(event) {
    const viewport = window.visualViewport, canvas = $('unity-canvas'), app = $('app');
    const focused = document.activeElement?.classList.contains('native-input');
    const sample = {
      ms:number(performance.now()-started), event,
      viewport:viewport ? {w:number(viewport.width),h:number(viewport.height),top:number(viewport.offsetTop),pageTop:number(viewport.pageTop),scale:number(viewport.scale)} : null,
      window:{w:innerWidth,h:innerHeight,x:number(scrollX),y:number(scrollY),dpr:devicePixelRatio},
      root:layout(document.documentElement),body:layout(document.body),
      app:{...layout(app),keyboardOpen:app.classList.contains('keyboard-open'),top:getComputedStyle(app).top},
      player:layout($('player-area')),canvas:{...rect(canvas),pixels:[canvas.width,canvas.height]},
      focused:focused ? identify(document.activeElement) : document.activeElement?.tagName,
      inputs:[...document.querySelectorAll('.native-input')].map(e=>({id:identify(e),...rect(e),length:e.value.length,
        composing:compositions.has(e),readOnly:e.readOnly,disabled:e.disabled,hidden:e.hidden,clip:getComputedStyle(e).clipPath})),
      // Unity's MobileKeyboard.js stores these references on an unnamed container.
      unityKeyboard:[...document.body.children].filter(e=>e.input instanceof HTMLElement && e.okButton instanceof HTMLElement).map(rect),
      dialogs:{about:$('about-dialog').open,cloud:$('cloud-dialog').open}
    };
    if (focused) lastFocused = sample;
    samples.push(sample);
    if (samples.length > 32) samples.shift();
  }
  function schedule(event) {
    pending.push(event);
    if (frame) return;
    frame = requestAnimationFrame(() => { frame=0; const events=pending; pending=[]; capture(events); });
  }
  for (const type of ['focusin','focusout','pointerdown','beforeinput','input','compositionstart','compositionend']) {
    document.addEventListener(type,event=>{
      const native = event.target?.classList?.contains('native-input');
      if (native) {
        if (type==='compositionstart' || (type==='input' && event.isComposing)) compositions.add(event.target);
        if (type==='compositionend') compositions.delete(event.target);
      }
      schedule(native ? {type,target:identify(event.target),inputType:event.inputType,isComposing:event.isComposing} : type);
      if (native && type==='focusin') setTimeout(()=>schedule('focus-settled'),700);
    },true);
  }
  for (const type of ['resize','scroll']) {
    window.addEventListener(type,()=>schedule('window-'+type),{passive:true});
    window.visualViewport?.addEventListener(type,()=>schedule('viewport-'+type),{passive:true});
  }
  const observer = new ResizeObserver(()=>schedule('canvas-layout'));
  for (const id of ['app','player-area','unity-canvas']) observer.observe($(id));
  const report = () => JSON.stringify({version:'20261023-layout1',userAgent:navigator.userAgent,
    platform:navigator.platform,touchPoints:navigator.maxTouchPoints,
    coarse:matchMedia('(pointer: coarse)').matches,
    lastFocused,current:samples.at(-1),
    history:samples.map(s=>({ms:s.ms,event:s.event,viewport:s.viewport,scrollY:s.window.y,
      app:{y:s.app.y,h:s.app.h},canvas:{y:s.canvas.y,h:s.canvas.h,pixels:s.canvas.pixels},focused:s.focused,
      inputs:s.inputs.map(e=>({id:e.id,length:e.length,composing:e.composing,readOnly:e.readOnly,hidden:e.hidden}))}))});
  // An outline does not change layout. Its lower edge distinguishes canvas clipping
  // from empty space painted below the canvas in a physical-device screenshot.
  $('unity-canvas').style.outline='2px solid #d000d0';
  $('unity-canvas').style.outlineOffset='-2px';
  const button = document.createElement('button');
  button.id='copy-input-diagnostics'; button.textContent='입력 진단 복사';
  $('about-dialog').querySelector('nav.about-actions').appendChild(button);
  button.addEventListener('click',async()=>{
    capture('copy');
    const text=report();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent='복사했어요 · 채팅에 붙여넣기';
    } catch {
      window.HaedokWeb.download('haedok-input-diagnostics.json',text,'application/json');
      button.textContent='진단 파일을 저장했어요';
    }
  });
  window.HaedokInputDiagnostics={report};
  capture('diagnostics-start');
})();
