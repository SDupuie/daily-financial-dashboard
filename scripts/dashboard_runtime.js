(function () {
  const ALLOWED_TONES = new Set([
    'up', 'down', 'flat', 'amber', 'green', 'red',
    'macro', 'geo', 'corp', 'fed', 'crypto', 'win', 'loss', 'mix'
  ]);

  const $ = (id) => document.getElementById(id);
  const asObj = (v) => (v && typeof v === 'object' ? v : {});
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const asText = (v) => String(v ?? '');

  const esc = (v) => asText(v).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));

  const inline = (v) => esc(v).replace(/&lt;(\/?)(strong|em)&gt;/g, '<$1$2>');
  const tone = (v) => (ALLOWED_TONES.has(v) ? v : '');

  function setHtml(id, html) {
    const el = $(id);
    if (el) {
      el.innerHTML = html;
    }
  }

  function setText(id, text) {
    const el = $(id);
    if (el) {
      el.textContent = asText(text);
    }
  }

  function safeHttpsUrl(value) {
    const raw = asText(value).trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.href);
      if (url.protocol !== 'https:') return '';
      return url.href;
    } catch (_error) {
      return '';
    }
  }

  function showErrorBanner(message) {
    const root = $('runtime-banner');
    if (!root) return;
    root.hidden = false;
    root.textContent = message;
  }

  function normalize(data) {
    const d = asObj(data);
    return {
      masthead: asObj(d.masthead),
      tape: asObj(d.tape),
      lede: asObj(d.lede),
      stories: asArr(d.stories),
      renesas: asObj(d.renesas),
      crypto: asObj(d.crypto),
      earnings: asObj(d.earnings),
      weekAhead: asObj(d.weekAhead),
      footer: asObj(d.footer)
    };
  }

  function renderMasthead(d) {
    setText('mast-vol', d.masthead.volume);
    setText('mast-date', d.masthead.date);
    setText('subhead', d.masthead.subhead);
  }

  function renderTape(d) {
    setText('tape-label', d.tape.label);
    const rows = asArr(d.tape.rows);
    setHtml('tape-body', rows.map((rRaw) => {
      const r = asObj(rRaw);
      return `
    <tr>
      <td data-label="Instrument" aria-label="Instrument ${esc(r.name)} ${esc(r.ticker)}"><span class="name">${esc(r.name)}</span><span class="ticker">${esc(r.ticker)}</span></td>
      <td data-label="Last" aria-label="Last ${esc(r.last)}">${esc(r.last)}</td>
      <td data-label="Delta" aria-label="Delta ${esc(r.delta)}" class="${tone(r.dir)}">${esc(r.delta)}</td>
      <td data-label="Percent" aria-label="Percent ${esc(r.pct)}" class="${tone(r.dir)}">${esc(r.pct)}</td>
      <td data-label="Note">${esc(r.note)}</td>
    </tr>`;
    }).join(''));
  }

  function renderLede(d) {
    setText('lede-kicker', d.lede.kicker);
    setHtml('lede-headline', inline(d.lede.headline));
    setHtml('lede-paragraphs', asArr(d.lede.paragraphs).map((p) => `<p>${inline(p)}</p>`).join(''));
    setHtml('lede-cards', asArr(d.lede.cards).map((cRaw) => {
      const c = asObj(cRaw);
      return `
    <div class="side-card ${tone(c.tone)}">
      <div class="label">${esc(c.label)}</div>
      <div class="num">${esc(c.num)}</div>
      <p>${esc(c.body)}</p>
    </div>`;
    }).join(''));
  }

  function renderStories(d) {
    setHtml('stories', d.stories.map((sRaw) => {
      const s = asObj(sRaw);
      const safeUrl = safeHttpsUrl(s.url);
      return `
    <article class="story">
      <span class="tag ${tone(s.tone)}">${esc(s.tag)}</span>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.body)}</p>
      ${safeUrl ? `<a class="story-link" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Read more about ${esc(s.title)}">Read more</a>` : ''}
      ${s.pull ? `<div class="pull">${esc(s.pull)}</div>` : ''}
    </article>`;
    }).join(''));
  }

  function renderRenesas(d) {
    setText('renesas-label', d.renesas.label);
    setText('renesas-title', d.renesas.title);
    setText('renesas-head', d.renesas.head);
    setHtml('renesas-headline', inline(d.renesas.headline));
    setHtml('renesas-paragraphs', asArr(d.renesas.paragraphs).map((p) => `<p>${inline(p)}</p>`).join(''));
    setHtml('renesas-stats', asArr(d.renesas.stats).map((sRaw) => {
      const s = asObj(sRaw);
      return `
    <div class="rstat">
      <div class="rk">${esc(s.key)}</div>
      <div class="rv ${tone(s.tone)}">${esc(s.value)}</div>
      <small>${esc(s.small)}</small>
    </div>`;
    }).join(''));
  }

  function renderCrypto(d) {
    setText('crypto-tape-header', d.crypto.tapeHeader);
    setHtml('crypto-tape-rows', asArr(d.crypto.tape).map((rRaw) => {
      const r = asObj(rRaw);
      return `
    <div class="crypto-row">
      <div class="crypto-sym">${esc(r.sym)}</div>
      <div class="crypto-name">${esc(r.name)} <span>${esc(r.sub)}</span></div>
      <div class="crypto-price">${esc(r.price)}</div>
      <div class="crypto-chg ${tone(r.dir)}">${esc(r.chg)}</div>
    </div>`;
    }).join(''));

    setHtml('crypto-notes', asArr(d.crypto.notes).map((nRaw) => {
      const n = asObj(nRaw);
      return `
    <div class="cnote">
      <div class="ckicker">${esc(n.kicker)}</div>
      <h4>${esc(n.title)}</h4>
      <p>${inline(n.body)}</p>
    </div>`;
    }).join(''));
  }

  function renderEarnings(d) {
    setText('earnings-label', d.earnings.label);
    setHtml('earnings-grid', asArr(d.earnings.tiles).map((tRaw) => {
      const t = asObj(tRaw);
      return `
    <div class="ern ${tone(t.tone)}">
      <div class="co">${esc(t.co)}</div>
      <div class="move ${tone(t.moveDir || 'flat')}">${esc(t.move)}</div>
      <p>${esc(t.body)}</p>
    </div>`;
    }).join(''));
  }

  function renderWeekAhead(d) {
    setHtml('week-ahead', asArr(d.weekAhead.rows).map((rRaw) => {
      const r = asObj(rRaw);
      return `
    <div class="ahead-row">
      <div class="ahead-day">${esc(r.day)}</div>
      <div class="ahead-event">${inline(r.event)}</div>
      <div class="ahead-tickers">${esc(r.tickers)}</div>
    </div>`;
    }).join(''));
  }

  function renderFooter(d) {
    setText('footer-compiled', d.footer.compiled);
    setText('footer-disclaimer', d.footer.disclaimer);
  }

  function readDashboardData() {
    const node = $('dashboard-data');
    if (!node) {
      throw new Error('dashboard-data script block is missing.');
    }

    let parsed;
    try {
      parsed = JSON.parse(node.textContent || '');
    } catch (_error) {
      throw new Error('Embedded dashboard JSON is invalid.');
    }

    return normalize(parsed);
  }

  function boot() {
    try {
      const d = readDashboardData();
      renderMasthead(d);
      renderTape(d);
      renderLede(d);
      renderStories(d);
      renderRenesas(d);
      renderCrypto(d);
      renderEarnings(d);
      renderWeekAhead(d);
      renderFooter(d);
    } catch (error) {
      showErrorBanner(`Dashboard render error: ${error.message}`);
      if (window.console && typeof window.console.error === 'function') {
        window.console.error(error);
      }
    }
  }

  boot();
})();
