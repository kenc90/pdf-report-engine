import { htmlElementToReportDoc, renderToBuffer } from './browser/pdf-report-engine.js';

const tabs = Array.from(document.querySelectorAll('.demo-tab'));
const panels = Array.from(document.querySelectorAll('.demo-panel'));
const generateButton = document.getElementById('generate');
const updateButton = document.getElementById('update-style');
const status = document.getElementById('status');
const resultLabel = document.getElementById('result-label');
const preview = document.getElementById('preview');
const download = document.getElementById('download');
let currentUrl;

function activePanel() {
  return document.querySelector('.demo-panel.active');
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `demo-status${kind ? ` ${kind}` : ''}`;
}

function selectExample(example) {
  for (const tab of tabs) {
    const selected = tab.dataset.example === example;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    const selected = panel.id === `panel-${example}`;
    panel.classList.toggle('active', selected);
  }
  const isInvoice = example === 'invoice';
  updateButton.hidden = !isInvoice;
  setStatus(`Selected: ${tabs.find((tab) => tab.dataset.example === example)?.textContent.trim()}.`);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectExample(tab.dataset.example));
}

document.querySelector('.demo-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  selectExample(tabs[next].dataset.example);
});

updateButton.addEventListener('click', () => {
  const heading = document.getElementById('live-title');
  heading.style.color = heading.style.color === 'rgb(175, 56, 67)' ? '' : '#af3843';
  setStatus(`Page JavaScript changed the heading color to ${getComputedStyle(heading).color}. Capture now to include it.`, 'success');
});

function countPages(bytes) {
  let text = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

generateButton.addEventListener('click', async () => {
  const panel = activePanel();
  const target = panel?.querySelector('.demo-target');
  if (!target) {
    setStatus('This example has no target element to capture.', 'error');
    return;
  }

  generateButton.disabled = true;
  download.hidden = true;
  setStatus('Reading current DOM and rendering PDF…');
  try {
    const options = panel.dataset.example === 'bands'
      ? {
          page: { size: 'a5', margin: 36 },
          header: '<div style="font-size:9px;font-weight:bold;color:#174a73;border-bottom:1px solid #dbe5ef;padding-bottom:6px">NORTHWIND STUDIO · OPERATIONS</div>',
          footer: '<div style="font-size:8px;color:#586c80;text-align:right;border-top:1px solid #dbe5ef;padding-top:5px">Confidential · Page {PAGE} of {TOTAL}</div>',
        }
      : {};
    const report = htmlElementToReportDoc(target, options);
    const bytes = await renderToBuffer(report);
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    preview.src = currentUrl;
    download.href = currentUrl;
    download.hidden = false;

    const pages = countPages(bytes);
    const expectation = panel.dataset.status;
    const message = expectation === 'lossy'
      ? `PDF created (${pages || '?'} page(s)), but this example intentionally loses unsupported visual content/layout.`
      : `PDF created successfully (${pages || '?'} page(s)).`;
    const kind = expectation === 'lossy' ? 'warning' : 'success';
    setStatus(message, kind);
    resultLabel.textContent = message;
    resultLabel.className = `demo-status ${kind}`;
    document.getElementById('preview-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Capture failed: ${message}`, 'error');
    resultLabel.textContent = `Capture failed: ${message}`;
    resultLabel.className = 'demo-status error';
  } finally {
    generateButton.disabled = false;
  }
});

const canvas = document.getElementById('sample-canvas');
const context = canvas.getContext('2d');
if (context) {
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#d9e3ed';
  context.lineWidth = 1;
  for (let y = 30; y < 180; y += 38) {
    context.beginPath();
    context.moveTo(40, y);
    context.lineTo(500, y);
    context.stroke();
  }
  const values = [68, 96, 82, 132, 118, 160];
  const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  values.forEach((value, index) => {
    const x = 70 + index * 72;
    context.fillStyle = '#3982b8';
    context.fillRect(x, 174 - value, 34, value);
    context.fillStyle = '#526579';
    context.font = '12px Arial';
    context.fillText(labels[index], x + 3, 188);
  });
}
