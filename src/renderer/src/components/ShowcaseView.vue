<script setup lang="ts">
defineProps<{
  appName: string
  version: string
  configured: boolean
}>()

const emit = defineEmits<{
  start: []
  settings: []
}>()
</script>

<template>
  <main class="showcase" aria-labelledby="showcase-title">
    <div class="showcase-orbit showcase-orbit-one" />
    <div class="showcase-orbit showcase-orbit-two" />
    <header class="showcase-nav">
      <div class="showcase-brand">
        <span class="showcase-mark">L</span>
        <span>{{ appName }}</span>
      </div>
      <div class="showcase-nav-meta">
        <span>Creative Production OS</span>
        <span class="showcase-version">{{ version ? `v${version}` : 'Local-first' }}</span>
        <button type="button" class="showcase-text-button" @click="emit('settings')">Settings</button>
      </div>
    </header>

    <section class="showcase-hero">
      <div class="showcase-hero-copy">
        <p class="showcase-kicker">PRIVATE BY DESIGN · OPENAI-COMPATIBLE IMAGES API</p>
        <h1 id="showcase-title">Make the image.<br /><em>Keep the control.</em></h1>
        <p class="showcase-lede">
          A local-first creative production workspace for generation, editing, batch remake, PSD delivery and turntable previews.
          <span>Your key only goes to the provider you confirm; deliverables stay on this Mac.</span>
        </p>
        <div class="showcase-actions">
          <button type="button" class="showcase-primary" @click="emit('start')">Start creating <b>↗</b></button>
          <button type="button" class="showcase-secondary" @click="emit('settings')">Configure provider</button>
        </div>
        <div class="showcase-proof-line">
          <span><i class="proof-dot" /> {{ configured ? 'Provider ready' : 'Bring your own key' }}</span>
          <span>Encrypted at rest</span>
          <span>No telemetry</span>
        </div>
      </div>
      <div class="showcase-hero-stage" aria-label="LUK Image Workspace product preview">
        <div class="stage-window stage-window-back">
          <div class="stage-window-bar"><span /><span /><span /><label>Batch remake</label></div>
          <div class="stage-canvas stage-canvas-coral"><div class="stage-product-bottle" /><div class="stage-word">FORM<br /><small>OBJECT / 04</small></div></div>
        </div>
        <div class="stage-window stage-window-front">
          <div class="stage-window-bar"><span /><span /><span /><label>Quick Generate</label></div>
          <div class="stage-front-body">
            <div class="stage-sidebar-lines"><b /><i /><i /><i /><i /></div>
            <div class="stage-main-preview"><div class="stage-light-box" /><div class="stage-card-copy">PRODUCT<br /><strong>STUDY</strong></div></div>
            <div class="stage-control-lines"><b /> <i /> <i /> <em>GENERATE</em></div>
          </div>
        </div>
        <div class="stage-caption"><span>01</span><b>One workspace</b><small>from prompt to production file</small></div>
      </div>
    </section>

    <section class="showcase-feature-section">
      <div class="showcase-section-head">
        <p class="showcase-kicker">THE WORKBENCH</p>
        <h2>From first frame<br /><em>to final deliverable.</em></h2>
        <p>Six workflows, one local queue. Every generated frame becomes a usable file—not a disappearing URL.</p>
      </div>
      <div class="showcase-feature-grid">
        <article class="feature-shot feature-shot-wide feature-shot-quick">
          <div class="shot-topline"><span>01 / QUICK GENERATE</span><span>TEXT → IMAGE</span></div>
          <div class="shot-art shot-art-editorial"><div class="shot-sun" /><div class="shot-object" /><strong>OBJECT<br />IN LIGHT</strong></div>
          <footer><b>Quick Generate</b><span>Prompt, size, quality, local save</span></footer>
        </article>
        <article class="feature-shot feature-shot-tall feature-shot-detail">
          <div class="shot-topline"><span>02 / DETAIL PAGE</span><span>08 SCENES</span></div>
          <div class="shot-art shot-art-detail"><div /><div /><div /><div /></div>
          <footer><b>Detail Page Workflow</b><span>Plan → select → produce</span></footer>
        </article>
        <article class="feature-shot feature-shot-batch">
          <div class="shot-topline"><span>03 / BATCH REMAKE</span><span>SKU SYSTEM</span></div>
          <div class="shot-art shot-art-batch"><div class="batch-row"><i /><i /><i /><i /></div><div class="batch-row offset"><i /><i /><i /><i /></div><span class="batch-label">REMAKE / SKU</span></div>
          <footer><b>Batch Remake / SKU</b><span>One visual language, many variants</span></footer>
        </article>
        <article class="feature-shot feature-shot-crop">
          <div class="shot-topline"><span>04 / LOCAL CROP</span><span>EDIT</span></div>
          <div class="shot-art shot-art-crop"><div class="crop-photo" /><div class="crop-selection" /><span>KEEP FRAME / CHANGE SUBJECT</span></div>
          <footer><b>Local Crop</b><span>Paint the change, preserve the frame</span></footer>
        </article>
        <article class="feature-shot feature-shot-psd">
          <div class="shot-topline"><span>05 / IMAGE → PSD</span><span>LOCAL TOOL</span></div>
          <div class="shot-art shot-art-psd"><div class="psd-image" /><div class="psd-layers"><b /><i /><i /><i /><i /></div><span>EDITABLE LAYERS</span></div>
          <footer><b>Image → PSD</b><span>Continue the work in Photoshop or Photopea</span></footer>
        </article>
        <article class="feature-shot feature-shot-turntable">
          <div class="shot-topline"><span>06 / TURNTABLE</span><span>08 ANGLES</span></div>
          <div class="shot-art shot-art-turntable"><div class="turntable-ring" /><div class="turntable-object" /><span>01—08</span></div>
          <footer><b>8-angle Turntable</b><span>Preview the spin, export WebM</span></footer>
        </article>
      </div>
    </section>

    <footer class="showcase-footer">
      <span>Local queue · Local history · Local deliverables</span>
      <span>English only</span>
      <button type="button" class="showcase-text-button" @click="emit('start')">Enter workspace →</button>
    </footer>
  </main>
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
:global(body) { margin: 0; }
.showcase {
  --ink: #181512;
  --paper: #f4f0e8;
  --muted: #827b70;
  --coral: #e7624c;
  min-height: 100vh;
  overflow: hidden;
  color: var(--ink);
  background: var(--paper);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  position: relative;
}
.showcase::before { content: ''; position: absolute; inset: 0; opacity: .42; pointer-events: none; background-image: radial-gradient(rgba(24,21,18,.09) .6px, transparent .6px); background-size: 7px 7px; mix-blend-mode: multiply; }
.showcase-nav, .showcase-hero, .showcase-feature-section, .showcase-footer { position: relative; z-index: 1; max-width: 1440px; margin: 0 auto; padding-left: clamp(28px, 5vw, 82px); padding-right: clamp(28px, 5vw, 82px); }
.showcase-nav { height: 78px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(24,21,18,.16); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.showcase-brand { display: flex; align-items: center; gap: 10px; font-weight: 750; letter-spacing: .04em; }
.showcase-mark { display: grid; place-items: center; width: 27px; height: 27px; background: var(--ink); color: var(--paper); font-family: Georgia, serif; font-size: 18px; font-weight: 400; }
.showcase-nav-meta { display: flex; align-items: center; gap: 22px; color: var(--muted); }
.showcase-version { color: var(--ink); }
.showcase-text-button { border: 0; padding: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.showcase-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(420px, .9fr); align-items: center; gap: clamp(48px, 8vw, 140px); min-height: min(740px, calc(100vh - 78px)); padding-top: 70px; padding-bottom: 90px; }
.showcase-kicker { margin: 0 0 24px; color: var(--coral); font-size: 10px; font-weight: 800; letter-spacing: .18em; }
.showcase-hero h1, .showcase-section-head h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: clamp(60px, 7.6vw, 118px); line-height: .84; letter-spacing: -.075em; }
.showcase-hero h1 em, .showcase-section-head h2 em { color: var(--coral); font-style: italic; }
.showcase-lede { max-width: 480px; margin: 36px 0 30px; color: #5e574e; font-size: 15px; line-height: 1.7; }
.showcase-lede span { display: block; margin-top: 9px; color: var(--ink); font-size: 13px; }
.showcase-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.showcase-primary, .showcase-secondary { border: 1px solid var(--ink); padding: 14px 17px; cursor: pointer; font: inherit; font-size: 12px; letter-spacing: .02em; }
.showcase-primary { color: var(--paper); background: var(--ink); }
.showcase-primary span, .showcase-secondary span { margin-left: 8px; opacity: .58; font-size: 11px; }
.showcase-primary b { margin-left: 18px; color: var(--coral); font-size: 16px; }
.showcase-secondary { color: var(--ink); background: transparent; }
.showcase-proof-line { display: flex; flex-wrap: wrap; gap: 17px; margin-top: 28px; color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.showcase-proof-line span { display: flex; gap: 6px; align-items: center; }
.proof-dot { width: 6px; height: 6px; border-radius: 50%; background: #559276; }
.showcase-hero-stage { min-height: 440px; position: relative; transform: rotate(2deg); }
.stage-window { position: absolute; overflow: hidden; border: 1px solid rgba(24,21,18,.48); box-shadow: 15px 20px 44px rgba(46,34,24,.16); background: #e8e1d5; }
.stage-window-back { width: 66%; height: 66%; right: 0; top: 5%; transform: rotate(6deg); }
.stage-window-front { width: 83%; height: 72%; left: 3%; bottom: 7%; z-index: 2; transform: rotate(-5deg); background: #f9f5ee; }
.stage-window-bar { height: 27px; display: flex; align-items: center; gap: 4px; padding: 0 9px; border-bottom: 1px solid rgba(24,21,18,.18); background: rgba(255,255,255,.35); }
.stage-window-bar span { width: 5px; height: 5px; border-radius: 50%; background: #a9a196; }.stage-window-bar span:first-child { background: var(--coral); }.stage-window-bar label { margin-left: auto; color: #81786b; font-size: 7px; letter-spacing: .1em; text-transform: uppercase; }
.stage-canvas-coral { height: calc(100% - 27px); position: relative; background: linear-gradient(135deg, #e96750 0 56%, #f5c7a5 56%); }
.stage-product-bottle { position: absolute; left: 43%; top: 21%; width: 27%; height: 58%; border-radius: 24% 24% 15% 15%; background: linear-gradient(90deg, #f9e6c5, #a6593d 54%, #3a2019); box-shadow: 13px 16px 0 rgba(83,28,17,.18); }.stage-product-bottle::before { content: ''; position: absolute; left: 26%; top: -12%; width: 49%; height: 18%; background: #5a3024; }.stage-word { position: absolute; left: 9%; bottom: 10%; color: #301b13; font: 700 22px/0.82 Georgia, serif; letter-spacing: -.08em; }.stage-word small { font: 600 5px/1 Inter, sans-serif; letter-spacing: .14em; }
.stage-front-body { height: calc(100% - 27px); display: grid; grid-template-columns: 18% 60% 22%; padding: 10px; gap: 9px; }
.stage-sidebar-lines, .stage-control-lines { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }.stage-sidebar-lines b, .stage-sidebar-lines i, .stage-control-lines b, .stage-control-lines i { height: 5px; width: 80%; background: #d0c7ba; }.stage-sidebar-lines b, .stage-control-lines b { background: var(--coral); width: 60%; }.stage-main-preview { position: relative; overflow: hidden; background: #c9b7a0; }.stage-light-box { position: absolute; left: 15%; top: 15%; width: 70%; height: 65%; background: linear-gradient(135deg, #f3e6ce, #a36f50); transform: rotate(-10deg); }.stage-card-copy { position: absolute; left: 10%; bottom: 8%; color: #31241b; font: 7px/1.1 Inter, sans-serif; letter-spacing: .15em; }.stage-card-copy strong { font: 18px/0.8 Georgia, serif; letter-spacing: -.06em; }.stage-control-lines em { margin-top: auto; padding: 5px; color: #fff; background: var(--ink); font-size: 6px; font-style: normal; text-align: center; }
.stage-caption { position: absolute; right: 2%; bottom: 0; z-index: 3; display: flex; flex-direction: column; align-items: flex-end; color: var(--muted); font-size: 10px; letter-spacing: .05em; }.stage-caption span { color: var(--coral); font: 28px Georgia, serif; }.stage-caption b { color: var(--ink); }.stage-caption small { font-size: 8px; }
.showcase-feature-section { padding-top: 96px; padding-bottom: 100px; }.showcase-section-head { display: grid; grid-template-columns: 1fr 1.2fr .8fr; gap: 28px; align-items: end; border-top: 1px solid rgba(24,21,18,.2); padding-top: 22px; }.showcase-section-head .showcase-kicker { margin-bottom: 0; align-self: start; }.showcase-section-head h2 { font-size: clamp(48px, 5vw, 76px); }.showcase-section-head > p:last-child { max-width: 260px; margin: 0 0 4px; color: var(--muted); font-size: 12px; line-height: 1.65; }
.showcase-feature-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 15px; margin-top: 54px; }.feature-shot { min-height: 250px; display: flex; flex-direction: column; padding: 15px; color: var(--ink); background: #e6ded1; }.feature-shot-wide { grid-column: span 5; }.feature-shot-tall { grid-column: span 3; min-height: 390px; }.feature-shot-batch, .feature-shot-crop, .feature-shot-psd, .feature-shot-turntable { grid-column: span 4; }.feature-shot-quick { background: #d5c1aa; }.feature-shot-detail { background: #d8d5c9; }.feature-shot-batch { background: #1e1d1a; color: #eee8dc; }.feature-shot-crop { background: #e2c1a7; }.feature-shot-psd { background: #c7d0c5; }.feature-shot-turntable { background: #e4b3a6; }.shot-topline { display: flex; justify-content: space-between; font-size: 8px; font-weight: 800; letter-spacing: .12em; opacity: .7; }.shot-art { flex: 1; min-height: 160px; position: relative; overflow: hidden; margin: 12px 0 18px; }.feature-shot-tall .shot-art { min-height: 270px; }.feature-shot footer { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid currentColor; padding-top: 10px; }.feature-shot footer b { font: 18px Georgia, serif; letter-spacing: -.04em; }.feature-shot footer span { font-size: 10px; opacity: .63; }
.shot-art-editorial { background: linear-gradient(115deg, #e8cfac 0 46%, #6d4a3e 46%); }.shot-sun { position: absolute; width: 75px; height: 75px; top: 22%; left: 18%; border-radius: 50%; background: #f5e9d2; box-shadow: 0 0 35px #fff0cb; }.shot-object { position: absolute; width: 74px; height: 110px; left: 57%; bottom: 12%; border-radius: 30px 30px 9px 9px; background: linear-gradient(90deg, #d8b67d, #5f3d32); transform: rotate(13deg); }.shot-art-editorial strong { position: absolute; left: 5%; bottom: 9%; color: #35241d; font: 24px/.78 Georgia, serif; letter-spacing: -.08em; }
.shot-art-detail { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }.shot-art-detail div { background: #a99d89; }.shot-art-detail div:nth-child(2) { background: #bd785a; }.shot-art-detail div:nth-child(3) { background: #6d786e; }.shot-art-detail div:nth-child(4) { background: #dfc7a2; }
.shot-art-batch { padding: 25px 16px; background: repeating-linear-gradient(135deg, #34312b 0, #34312b 1px, #25231f 1px, #25231f 9px); }.batch-row { display: flex; gap: 6px; margin: 0 0 12px; }.batch-row.offset { transform: translateX(25px); }.batch-row i { display: block; width: 45px; height: 62px; background: #d17b5e; }.batch-row i:nth-child(2) { background: #b4a887; }.batch-row i:nth-child(3) { background: #e4d0ad; }.batch-row i:nth-child(4) { background: #829486; }.batch-label { position: absolute; right: 12px; bottom: 12px; color: #e7624c; font-size: 9px; letter-spacing: .16em; }
.shot-art-crop { background: #967e6e; }.crop-photo { position: absolute; inset: 12% 10%; background: linear-gradient(140deg, #cdbb9e, #5e443a); }.crop-selection { position: absolute; left: 32%; top: 24%; width: 35%; height: 45%; border: 2px solid var(--coral); box-shadow: 0 0 0 999px rgba(22,15,12,.24); }.shot-art-crop span, .shot-art-psd span { position: absolute; left: 10px; bottom: 8px; color: #f4e7d6; font-size: 8px; letter-spacing: .12em; }
.shot-art-psd { display: grid; grid-template-columns: 1fr 28%; gap: 8px; background: #dfe7dd; }.psd-image { background: linear-gradient(135deg, #efcfad, #7c9b91); }.psd-layers { display: flex; flex-direction: column; gap: 5px; padding: 7px; background: #afbcae; }.psd-layers b, .psd-layers i { height: 8px; background: #f4f0e8; }.psd-layers b { background: var(--coral); }
.shot-art-turntable { display: grid; place-items: center; background: radial-gradient(circle at center, #f5d8bd 0 26%, transparent 27%), linear-gradient(135deg, #bb6556, #e7b49d); }.turntable-ring { position: absolute; width: 150px; height: 75px; border: 1px solid rgba(255,247,231,.7); border-radius: 50%; transform: rotate(-12deg); }.turntable-ring::after { content: ''; position: absolute; inset: 13px 22px; border: 1px solid rgba(255,247,231,.5); border-radius: 50%; }.turntable-object { width: 45px; height: 83px; border-radius: 18px 18px 8px 8px; background: linear-gradient(90deg, #e2bb84, #855347); transform: rotate(-10deg); }.shot-art-turntable span { position: absolute; bottom: 9px; right: 10px; color: #fff3e3; font: 16px Georgia, serif; }
.showcase-footer { display: flex; justify-content: space-between; align-items: center; gap: 20px; border-top: 1px solid rgba(24,21,18,.2); padding-top: 20px; padding-bottom: 28px; color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }.showcase-footer .showcase-text-button { color: var(--ink); }
.showcase-orbit { position: absolute; border: 1px solid rgba(231,98,76,.25); border-radius: 50%; pointer-events: none; }.showcase-orbit-one { width: 600px; height: 600px; right: -250px; top: 180px; }.showcase-orbit-two { width: 330px; height: 330px; left: -220px; bottom: 220px; }
@media (max-width: 900px) { .showcase-hero { grid-template-columns: 1fr; min-height: auto; }.showcase-hero-stage { min-height: 390px; }.showcase-section-head { grid-template-columns: 1fr 1fr; }.showcase-section-head > p:last-child { grid-column: 2; }.feature-shot-wide { grid-column: span 7; }.feature-shot-tall { grid-column: span 5; }.feature-shot-batch, .feature-shot-crop, .feature-shot-psd, .feature-shot-turntable { grid-column: span 6; } }
@media (max-width: 620px) { .showcase-nav-meta > span:first-child { display: none; }.showcase-nav { height: 64px; }.showcase-hero { padding-top: 56px; }.showcase-hero h1 { font-size: 60px; }.showcase-section-head { display: block; }.showcase-section-head h2 { margin: 24px 0; }.showcase-feature-grid { display: block; }.feature-shot { margin-bottom: 14px; min-height: 280px; }.showcase-footer { flex-wrap: wrap; }.showcase-hero-stage { min-height: 320px; transform: scale(.9) rotate(2deg); transform-origin: left center; } }
@media (prefers-reduced-motion: no-preference) { .stage-window-front { animation: showcase-float 7s ease-in-out infinite; }.stage-window-back { animation: showcase-float-back 9s ease-in-out infinite; }.showcase-orbit-one { animation: showcase-orbit 18s linear infinite; } }
@keyframes showcase-float { 0%, 100% { transform: rotate(-5deg) translateY(0); } 50% { transform: rotate(-5deg) translateY(-8px); } }
@keyframes showcase-float-back { 0%, 100% { transform: rotate(6deg) translateY(0); } 50% { transform: rotate(6deg) translateY(10px); } }
@keyframes showcase-orbit { to { transform: rotate(360deg); } }
</style>
