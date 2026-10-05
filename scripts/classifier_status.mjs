export const STATUS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Route2 classifier status</title><style>
body{margin:0;background:#111820;color:#eef4f7;font:17px/1.6 system-ui,sans-serif}main{max-width:650px;margin:12vh auto;padding:28px}
h1{font-size:36px;line-height:1.2}small{color:#97a9b7}#state{display:inline-block;background:#233847;border-radius:8px;padding:5px 14px;font-weight:600}
#state[data-state=ready]{background:#194836}#state[data-state=error]{background:#672e32}#details{border-top:1px solid #31404d;padding-top:20px}
</style></head><body><main><small>LOCAL ROUTING SERVICE</small><h1>Route2 classifier</h1><div id="state">Connecting</div>
<p id="message" role="status" aria-live="polite">Checking local classifier readiness…</p><small id="timing"></small>
<p id="details">The local classifier warms up when the service starts and stays in memory. While it loads or is unavailable, coding requests use fallback routing rather than waiting for startup.</p>
<small>Setup prepares dependencies and weights. This page shows classifier status, not the coding model’s thinking or response time.</small>
</main><script>
const state = document.getElementById('state');
const message = document.getElementById('message');
const timing = document.getElementById('timing');
async function refresh(){
  try{
    const response = await fetch('/health', {cache:'no-store', signal:AbortSignal.timeout(3000)});
    if(!response.ok) throw new Error('Service unavailable');
    const health = await response.json();
    const classifier = health.classifier;
    state.textContent = classifier?.state || 'Status unavailable';
    state.dataset.state = classifier?.state || 'error';
    message.textContent = classifier?.message || 'This service does not report classifier readiness. Update Route2 to enable startup status.';
    timing.textContent = classifier ? 'Stage: ' + classifier.stage + ' · Startup: ' + (classifier.elapsed_ms / 1000).toFixed(1) + 's' : '';
  }catch{
    state.textContent='Disconnected';state.dataset.state='error';
    message.textContent='The local Route2 service is not responding. Check its service logs.';timing.textContent='';
  }
  setTimeout(refresh,1000);
}
refresh();
</script></body></html>`;
