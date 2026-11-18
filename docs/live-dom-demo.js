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
let generation = 0;
const comprehensiveReference = 'OPS-2026-Q3-026';

function activePanel() {
  return document.querySelector('.demo-panel.active');
}

async function generateActiveReport(scrollToPreview = false) {
  const requestId = ++generation;
  const panel = activePanel();
  const target = panel?.querySelector('.demo-target');
  if (!target) {
    setStatus('This example has no target element to capture.', 'error');
    resultLabel.textContent = 'This example has no target element to capture.';
    resultLabel.className = 'demo-status error';
    return;
  }

  generateButton.disabled = true;
  download.hidden = true;
  download.removeAttribute('href');
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = undefined;
  preview.removeAttribute('src');
  resultLabel.textContent = 'Generating PDF…';
  resultLabel.className = 'demo-status';
  setStatus('Reading current DOM and rendering PDF…');
  try {
    const example = panel.dataset.example;
    const options = example === 'bands' || example === 'comprehensive'
      ? {
          page: { size: example === 'bands' ? 'a5' : 'a4', margin: 36 },
          header: example === 'bands'
            ? '<div style="font-size:9px;font-weight:bold;color:#174a73;border-bottom:1px solid #dbe5ef;padding-bottom:6px">NORTHWIND STUDIO · OPERATIONS</div>'
            : '<div style="font-size:9px;font-weight:bold;color:#174a73;border-bottom:1px solid #dbe5ef;padding-bottom:6px">NORTHWIND STUDIO · QUARTERLY SERVICE REVIEW</div>',
          footer: example === 'bands'
            ? '<div style="font-size:8px;color:#586c80;text-align:right;border-top:1px solid #dbe5ef;padding-top:5px">Confidential · Page {PAGE} of {TOTAL}</div>'
            : '<div style="font-size:8px;color:#586c80;text-align:right;border-top:1px solid #dbe5ef;padding-top:5px">Internal use · Page {PAGE} of {TOTAL}</div>',
        }
      : {};
    const report = htmlElementToReportDoc(target, options);
    const bytes = await renderToBuffer(report);
    if (requestId !== generation) return;
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
    if (scrollToPreview) {
      document.getElementById('preview-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    if (requestId !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Capture failed: ${message}`, 'error');
    resultLabel.textContent = `Capture failed: ${message}`;
    resultLabel.className = 'demo-status error';
  } finally {
    if (requestId === generation) generateButton.disabled = false;
  }
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
  void generateActiveReport();
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

generateButton.addEventListener('click', () => void generateActiveReport(true));

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

const comprehensiveCanvas = document.getElementById('comprehensive-chart');
const comprehensiveContext = comprehensiveCanvas.getContext('2d');
if (comprehensiveContext) {
  const categories = ['Jul', 'Aug', 'Sep'];
  const series = [
    { name: 'Support', values: [420, 465, 492], color: '#3982b8' },
    { name: 'Data', values: [280, 310, 344], color: '#23659e' },
    { name: 'Reporting', values: [190, 205, 228], color: '#e29b38' },
  ];
  const plot = { left: 48, top: 14, width: 450, height: 142 };
  const maxValue = 600;
  const bottom = plot.top + plot.height;

  comprehensiveContext.fillStyle = '#fff';
  comprehensiveContext.fillRect(0, 0, comprehensiveCanvas.width, comprehensiveCanvas.height);
  comprehensiveContext.font = '11px Arial';
  comprehensiveContext.textAlign = 'right';
  comprehensiveContext.textBaseline = 'middle';
  comprehensiveContext.strokeStyle = '#d9e3ed';
  comprehensiveContext.fillStyle = '#526579';
  for (let value = 0; value <= maxValue; value += 150) {
    const y = bottom - (value / maxValue) * plot.height;
    comprehensiveContext.beginPath();
    comprehensiveContext.moveTo(plot.left, y);
    comprehensiveContext.lineTo(plot.left + plot.width, y);
    comprehensiveContext.stroke();
    comprehensiveContext.fillText(String(value), plot.left - 8, y);
  }

  const slotWidth = plot.width / categories.length;
  const barWidth = 24;
  const barGap = 6;
  categories.forEach((category, categoryIndex) => {
    const groupWidth = series.length * barWidth + (series.length - 1) * barGap;
    const groupLeft = plot.left + categoryIndex * slotWidth + (slotWidth - groupWidth) / 2;
    series.forEach((item, seriesIndex) => {
      const barHeight = (item.values[categoryIndex] / maxValue) * plot.height;
      comprehensiveContext.fillStyle = item.color;
      comprehensiveContext.fillRect(
        groupLeft + seriesIndex * (barWidth + barGap),
        bottom - barHeight,
        barWidth,
        barHeight,
      );
    });
    comprehensiveContext.textAlign = 'center';
    comprehensiveContext.fillStyle = '#526579';
    comprehensiveContext.fillText(category, plot.left + categoryIndex * slotWidth + slotWidth / 2, bottom + 12);
  });

  comprehensiveContext.textAlign = 'left';
  comprehensiveContext.textBaseline = 'middle';
  series.forEach((item, index) => {
    const x = 95 + index * 125;
    comprehensiveContext.fillStyle = item.color;
    comprehensiveContext.fillRect(x, 194, 10, 10);
    comprehensiveContext.fillStyle = '#526579';
    comprehensiveContext.fillText(item.name, x + 15, 199);
  });
}

const comprehensiveBarcode = document.getElementById('comprehensive-barcode');
const barcodeContext = comprehensiveBarcode.getContext('2d');
if (barcodeContext) {
  // Code 128 modules for the fixed reference shown in this demo.
  const modules = '11010010000100011101101110111011011011101000100110111001100111001010011101100110011100101100111010010011011100110100011101100101110010011011100100111011001100111001011001110100111010011001100011101011';
  const quietZone = 10;
  const moduleWidth = comprehensiveBarcode.width / (modules.length + quietZone * 2);
  const barHeight = 126;
  barcodeContext.fillStyle = '#fff';
  barcodeContext.fillRect(0, 0, comprehensiveBarcode.width, comprehensiveBarcode.height);
  barcodeContext.fillStyle = '#174a73';
  for (let index = 0; index < modules.length; index += 1) {
    if (modules[index] === '1') {
      barcodeContext.fillRect((quietZone + index) * moduleWidth, 0, moduleWidth, barHeight);
    }
  }
  barcodeContext.font = '30px Arial';
  barcodeContext.textAlign = 'center';
  barcodeContext.fillText(comprehensiveReference, comprehensiveBarcode.width / 2, 164);
}

void generateActiveReport();
