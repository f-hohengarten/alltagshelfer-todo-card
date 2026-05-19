// ─── Constants ────────────────────────────────────────────────────────────────

const RECUR_DE_MAP = {
  'täglich': 'daily',    'daily':    'daily',
  'wöchentlich': 'weekly', 'weekly': 'weekly',
  'monatlich': 'monthly', 'monthly': 'monthly',
  'jährlich': 'yearly',  'yearly':  'yearly',
  'werktags': 'weekdays', 'weekdays':'weekdays',
};

const REMIND_DE_MAP = {
  'am fälligkeitstag': '0', '0': '0', 'heute': '0',
  '1 tag vorher': '1',      '1': '1',
};

const CSV_TEMPLATE = [
  'Titel;Fälligkeitsdatum;Wiederholung;Erinnerung',
  'Zahnarzt anrufen;2026-06-01;wöchentlich;am Fälligkeitstag',
  'Miete überweisen;2026-06-01;monatlich;1 Tag vorher',
  'Steuererklärung;;jährlich;',
  '# Wiederholung: täglich | wöchentlich | monatlich | jährlich | werktags',
  '# Erinnerung: am Fälligkeitstag | 1 Tag vorher | (leer = keine)',
  '# Datum: YYYY-MM-DD  (z.B. 2026-06-15) oder leer lassen',
  '# Zeilen die mit # beginnen werden ignoriert',
].join('\n');

const RECUR_OPTS = [
  { v: '',         l: 'Keine Wiederholung' },
  { v: 'daily',    l: 'Täglich' },
  { v: 'weekly',   l: 'Wöchentlich' },
  { v: 'monthly',  l: 'Monatlich' },
  { v: 'yearly',   l: 'Jährlich' },
  { v: 'weekdays', l: 'Werktags (Mo–Fr)' },
];

const REMIND_OPTS = [
  { v: '',  l: 'Keine Erinnerung' },
  { v: '0', l: 'Am Fälligkeitstag (09:00)' },
  { v: '1', l: '1 Tag vorher (09:00)' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseMeta(desc) {
  const m = String(desc ?? '').match(/^\[ALH ([^\]]*)\]([ \t]*)(.*)$/s);
  if (!m) return { recur: '', remind: '', note: String(desc ?? '') };
  const obj = {};
  m[1].split(';').forEach(p => {
    const i = p.indexOf(':');
    if (i > 0) obj[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return { recur: obj.recur ?? '', remind: obj.remind ?? '', note: m[3].trim() };
}

function encodeMeta({ recur, remind }) {
  const p = [];
  if (recur) p.push(`recur:${recur}`);
  if (remind !== '') p.push(`remind:${remind}`);
  return p.length ? `[ALH ${p.join(';')}]` : '';
}

function nextDue(dateStr, recur) {
  if (!dateStr || !recur) return null;
  const d = new Date(dateStr + 'T12:00:00');
  if (recur === 'daily')    d.setDate(d.getDate() + 1);
  if (recur === 'weekly')   d.setDate(d.getDate() + 7);
  if (recur === 'monthly')  d.setMonth(d.getMonth() + 1);
  if (recur === 'yearly')   d.setFullYear(d.getFullYear() + 1);
  if (recur === 'weekdays') {
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function fmtDue(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T12:00:00');
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const diff = Math.round((d - t) / 86400000);
  if (diff < 0)   return { txt: 'Überfällig', mod: 'overdue' };
  if (diff === 0) return { txt: 'Heute',      mod: 'today' };
  if (diff === 1) return { txt: 'Morgen',     mod: 'tomorrow' };
  return { txt: d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }), mod: 'future' };
}

function x(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Component ────────────────────────────────────────────────────────────────

class AlhTodoCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._items      = [];
    this._config     = { entity: '', title: 'Aufgaben', show_completed: false };
    this._hass       = null;
    this._showDone   = false;
    this._view       = 'all';  // 'all' | 'today' | 'week' | 'cal'
    this._bulkMode   = false;
    this._bulkTab    = 'text'; // 'text' | 'csv'
    this._bulkText   = '';
    this._csvItems   = [];
    this._calYear    = new Date().getFullYear();
    this._calMonth   = new Date().getMonth();
    this._calDay     = null;
    this._form       = this._blankForm();
    this._picker     = null;
    this._unsubFn    = null;
  }

  _blankForm() {
    return { open: false, uid: null, title: '', due: '', recur: '', remind: '' };
  }

  static getStubConfig() {
    return { entity: 'todo.aufgaben', title: 'Aufgaben', show_completed: false };
  }

  setConfig(config) {
    if (!config.entity) throw new Error('entity ist erforderlich');
    const entityChanged = config.entity !== this._config.entity;
    this._config   = { title: 'Aufgaben', show_completed: false, ...config };
    this._showDone = this._config.show_completed;
    if (entityChanged && this._hass) this._subscribe();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._config.entity) this._subscribe();
  }

  connectedCallback() {
    if (this._hass && this._config.entity && !this._unsubFn) this._subscribe();
  }

  disconnectedCallback() {
    if (this._unsubFn) { this._unsubFn(); this._unsubFn = null; }
  }

  async _subscribe() {
    if (this._unsubFn) { this._unsubFn(); this._unsubFn = null; }
    await this._fetchItems();
    try {
      this._unsubFn = await this._hass.connection.subscribeEvents(
        (event) => {
          if (event.data.entity_id === this._config.entity) {
            this._fetchItems();
          }
        },
        'state_changed'
      );
    } catch (e) {
      console.warn('[alh-todo-card] subscribeEvents fehlgeschlagen', e);
    }
  }

  async _fetchItems() {
    try {
      const result = await this._hass.callService(
        'todo', 'get_items',
        { status: ['needs_action', 'completed'] },
        { entity_id: this._config.entity },
        false,
        true
      );
      this._items = result.response?.[this._config.entity]?.items ?? [];
    } catch (e) {
      console.error('[alh-todo-card] fetchItems:', e);
      this._items = this._hass.states[this._config.entity]?.attributes?.items ?? [];
    }
    this._render();
  }

  getCardSize() { return 4; }

  // ─── Render ─────────────────────────────────────────────────────────────────

  _filterByView(items) {
    if (this._view === 'all') return items;
    const today   = isoToday();
    const weekEnd = isoPlus(7);
    return items.filter(i => {
      if (!i.due) return true;
      if (this._view === 'today') return i.due <= today;
      if (this._view === 'week')  return i.due <= weekEnd;
      return true;
    });
  }

  _render() {
    const inputEl = this.shadowRoot.querySelector('.form__input');
    if (inputEl) this._form.title = inputEl.value;

    const bulkEl = this.shadowRoot.querySelector('.bulk__textarea');
    if (bulkEl) this._bulkText = bulkEl.value;

    const active   = this._items.filter(i => i.status === 'needs_action');
    const openCnt  = active.length;
    const filtered = this._filterByView(this._showDone ? this._items : active);
    const isCal    = this._view === 'cal';

    this.shadowRoot.innerHTML = `
      <style>${this._css()}</style>
      <div class="card">
        ${this._header(openCnt)}
        ${this._bulkMode ? this._bulkHtml() : `
          ${this._viewTabs()}
          ${isCal ? this._calHtml() : `
            ${filtered.length ? `<ul class="list">${filtered.map(i => this._item(i)).join('')}</ul>` : this._empty()}
            ${this._form.open ? this._formHtml() : ''}
          `}
        `}
      </div>
    `;

    this._bind();

    if (this._form.open) {
      const inp = this.shadowRoot.querySelector('.form__input');
      if (inp) { inp.selectionStart = inp.selectionEnd = inp.value.length; inp.focus(); }
    }
    if (this._bulkMode) {
      const ta = this.shadowRoot.querySelector('.bulk__textarea');
      if (ta) { ta.value = this._bulkText; ta.focus(); }
    }
  }

  _header(openCnt) {
    return `
      <div class="header">
        <div class="header__left">
          <div class="header__icon">
            <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          </div>
          <span class="header__title">${x(this._config.title)}</span>
        </div>
        <div class="header__right">
          ${openCnt > 0 ? `<span class="badge">${openCnt}</span>` : ''}
          <button class="icon-btn${this._bulkMode ? ' icon-btn--active' : ''}" data-action="toggle-bulk" title="Mehrere hinzufügen">
            <svg viewBox="0 0 24 24"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
          </button>
          <button class="icon-btn${this._showDone ? ' icon-btn--active' : ''}" data-action="toggle-done" title="Erledigte anzeigen">
            <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
          </button>
          ${!this._bulkMode ? `
            <button class="add-btn" data-action="open-add" aria-label="Aufgabe hinzufügen">
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  _viewTabs() {
    const tabs = [
      { v: 'all',   l: 'Alle' },
      { v: 'today', l: 'Heute' },
      { v: 'week',  l: 'Woche' },
      { v: 'cal',   l: 'Kalender' },
    ];
    return `
      <div class="view-tabs">
        ${tabs.map(t => `
          <button class="view-tab${this._view === t.v ? ' view-tab--active' : ''}" data-view="${t.v}">${t.l}</button>
        `).join('')}
      </div>
    `;
  }

  _bulkHtml() {
    const isCSV = this._bulkTab === 'csv';
    return `
      <div class="bulk">
        <div class="bulk-tabs">
          <button class="bulk-tab${!isCSV ? ' bulk-tab--active' : ''}" data-bulk-tab="text">Text</button>
          <button class="bulk-tab${isCSV  ? ' bulk-tab--active' : ''}" data-bulk-tab="csv">CSV-Vorlage</button>
        </div>

        ${!isCSV ? `
          <textarea class="bulk__textarea" placeholder="Eine Aufgabe pro Zeile…" rows="6"></textarea>
          <div class="bulk__actions">
            <span class="bulk__hint">Eine Aufgabe pro Zeile · ohne Datum/Erinnerung</span>
            <button class="btn btn--ghost" data-action="bulk-cancel">Abbrechen</button>
            <button class="btn btn--primary" data-action="bulk-submit">Alle hinzufügen</button>
          </div>
        ` : `
          <div class="csv-zone">
            <p class="csv-info">Vorlage herunterladen, in Excel/Numbers ausfüllen und hochladen.</p>
            <div class="csv-btns">
              <button class="btn btn--ghost" data-action="csv-download">Vorlage herunterladen (.csv)</button>
              <label class="btn btn--ghost csv-upload-label">
                CSV hochladen
                <input type="file" accept=".csv,text/csv" class="csv-file-input" style="display:none" />
              </label>
            </div>
            ${this._csvItems.length ? `
              <div class="csv-preview">
                <span class="csv-preview__count">${this._csvItems.length} Aufgabe${this._csvItems.length !== 1 ? 'n' : ''} erkannt</span>
                <ul class="csv-preview__list">
                  ${this._csvItems.map(it => `
                    <li class="csv-preview__item">
                      <span class="csv-preview__title">${x(it.title)}</span>
                      <span class="csv-preview__meta">
                        ${it.due  ? `<span class="item__due item__due--future">${x(it.due)}</span>` : ''}
                        ${it.recur  ? `<span class="item__recur">↩ ${x(RECUR_OPTS.find(o=>o.v===it.recur)?.l ?? it.recur)}</span>` : ''}
                        ${it.remind !== '' ? `<span class="item__recur">${x(REMIND_OPTS.find(o=>o.v===it.remind)?.l ?? '')}</span>` : ''}
                      </span>
                    </li>
                  `).join('')}
                </ul>
              </div>
              <div class="bulk__actions">
                <button class="btn btn--ghost" data-action="bulk-cancel">Abbrechen</button>
                <button class="btn btn--primary" data-action="bulk-submit">Alle hinzufügen</button>
              </div>
            ` : ''}
          </div>
        `}
      </div>
    `;
  }

  _calHtml() {
    const year  = this._calYear;
    const month = this._calMonth;
    const today = isoToday();

    const monthLabel = new Date(year, month, 1)
      .toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

    const firstDow   = new Date(year, month, 1).getDay();
    const startOff   = firstDow === 0 ? 6 : firstDow - 1;
    const daysInMon  = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();

    const cells = [];
    for (let i = startOff - 1; i >= 0; i--)
      cells.push({ day: daysInPrev - i, other: true });
    for (let d = 1; d <= daysInMon; d++) {
      const iso   = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const tasks = this._items.filter(i => i.due === iso && i.status === 'needs_action');
      cells.push({ day: d, iso, tasks, isToday: iso === today, overdue: iso < today && tasks.length > 0 });
    }
    let nd = 1;
    while (cells.length % 7 !== 0) cells.push({ day: nd++, other: true });

    const selTasks = this._calDay
      ? this._items.filter(i => i.due === this._calDay && i.status === 'needs_action')
      : [];

    const wds = ['Mo','Di','Mi','Do','Fr','Sa','So'];

    return `
      <div class="cal">
        <div class="cal__nav">
          <button class="icon-btn" data-cal-nav="-1">
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <span class="cal__month">${x(monthLabel)}</span>
          <button class="icon-btn" data-cal-nav="1">
            <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
        <div class="cal__grid">
          ${wds.map(d => `<div class="cal__wd">${d}</div>`).join('')}
          ${cells.map(c => {
            if (c.other) return `<div class="cal__day cal__day--other"><span class="cal__day-num">${c.day}</span></div>`;
            const cls = ['cal__day',
              c.isToday                      ? 'cal__day--today'     : '',
              c.overdue                      ? 'cal__day--overdue'   : '',
              c.tasks?.length                ? 'cal__day--has-tasks' : '',
              this._calDay === c.iso         ? 'cal__day--selected'  : '',
            ].filter(Boolean).join(' ');
            return `
              <div class="${cls}" data-cal-day="${c.iso}">
                <span class="cal__day-num">${c.day}</span>
                ${c.tasks?.length ? `<span class="cal__dot">${c.tasks.length > 1 ? c.tasks.length : ''}</span>` : ''}
              </div>`;
          }).join('')}
        </div>
        ${this._calDay ? `
          <div class="cal__detail">
            <div class="cal__detail-title">
              ${x(new Date(this._calDay + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))}
            </div>
            ${selTasks.length
              ? `<ul class="list cal__detail-list">${selTasks.map(i => this._item(i)).join('')}</ul>`
              : `<div class="empty" style="padding:10px 0 4px">Keine Aufgaben</div>`}
          </div>` : ''}
      </div>
    `;
  }

  _empty() {
    const msgs = {
      all:   'Keine offenen Aufgaben',
      today: 'Nichts für heute fällig',
      week:  'Nichts für diese Woche fällig',
    };
    return `<div class="empty">${msgs[this._view] ?? 'Keine offenen Aufgaben'}</div>`;
  }

  _item(item) {
    const done  = item.status === 'completed';
    const meta  = parseMeta(item.description);
    const due   = fmtDue(item.due);
    const rLbl  = meta.recur ? RECUR_OPTS.find(o => o.v === meta.recur)?.l : null;
    const hasMeta = due || rLbl;
    return `
      <li class="item${done ? ' item--done' : ''}${due?.mod === 'overdue' ? ' item--overdue' : ''}" data-uid="${x(item.uid)}">
        <button class="item__check" data-action="toggle" data-uid="${x(item.uid)}" aria-label="${done ? 'Wiederherstellen' : 'Erledigen'}">
          <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        <button class="item__body" data-action="edit" data-uid="${x(item.uid)}">
          <span class="item__label">${x(item.summary)}</span>
          ${hasMeta ? `
            <div class="item__meta">
              ${due  ? `<span class="item__due item__due--${due.mod}">${due.txt}</span>` : ''}
              ${rLbl ? `<span class="item__recur">↩ ${x(rLbl)}</span>` : ''}
            </div>` : ''}
        </button>
        <button class="item__del" data-action="delete-item" data-uid="${x(item.uid)}" aria-label="Löschen">
          <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </li>
    `;
  }

  _formHtml() {
    const { uid, title, due, recur, remind } = this._form;
    const isEdit  = uid !== null;
    const rLabel  = recur  ? RECUR_OPTS.find(o => o.v === recur)?.l  : null;
    const rmLabel = remind !== '' ? REMIND_OPTS.find(o => o.v === remind)?.l : null;

    return `
      <div class="form">
        <input class="form__input" type="text" placeholder="Aufgabe hinzufügen…"
          value="${x(title)}" maxlength="255" />

        <div class="form__chips">
          <button class="chip${due ? ' chip--on' : ''}" data-picker="date">
            <svg viewBox="0 0 24 24"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>
            <span>${due ? x(due) : 'Datum'}</span>
          </button>
          <button class="chip${recur ? ' chip--on' : ''}" data-picker="recur">
            <svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
            <span>${rLabel ? x(rLabel) : 'Wiederholen'}</span>
          </button>
          <button class="chip${remind !== '' ? ' chip--on' : ''}${!due ? ' chip--off' : ''}"
            data-picker="remind" ${!due ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
            <span>${rmLabel ? x(rmLabel) : 'Erinnern'}</span>
          </button>
        </div>

        ${this._picker === 'date' ? `
          <div class="picker">
            <input class="picker__date" type="date" value="${x(due)}" min="${isoToday()}" />
            ${due ? `<button class="picker__clear" data-clear="date">Datum entfernen</button>` : ''}
          </div>` : ''}

        ${this._picker === 'recur' ? `
          <div class="picker picker--grid">
            ${RECUR_OPTS.map(o => `
              <button class="pill${recur === o.v ? ' pill--on' : ''}" data-recur="${x(o.v)}">${x(o.l)}</button>
            `).join('')}
          </div>` : ''}

        ${this._picker === 'remind' ? `
          <div class="picker picker--grid">
            ${REMIND_OPTS.map(o => `
              <button class="pill${remind === o.v ? ' pill--on' : ''}" data-remind="${x(o.v)}">${x(o.l)}</button>
            `).join('')}
          </div>` : ''}

        <div class="form__actions">
          ${isEdit ? `<button class="btn btn--danger" data-action="delete">Löschen</button>` : ''}
          <button class="btn btn--ghost" data-action="cancel">Abbrechen</button>
          <button class="btn btn--primary" data-action="submit">${isEdit ? 'Speichern' : 'Hinzufügen'}</button>
        </div>
      </div>
    `;
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  _bind() {
    const root = this.shadowRoot;

    root.querySelectorAll('[data-view]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._view = btn.dataset.view;
        this._render();
      })
    );

    root.querySelectorAll('[data-cal-nav]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._calMonth += parseInt(btn.dataset.calNav);
        if (this._calMonth > 11) { this._calMonth = 0;  this._calYear++; }
        if (this._calMonth < 0)  { this._calMonth = 11; this._calYear--; }
        this._calDay = null;
        this._render();
      })
    );

    root.querySelectorAll('[data-cal-day]').forEach(el =>
      el.addEventListener('click', () => {
        this._calDay = this._calDay === el.dataset.calDay ? null : el.dataset.calDay;
        this._render();
      })
    );

    root.querySelector('[data-action="toggle-bulk"]')?.addEventListener('click', () => {
      this._bulkMode = !this._bulkMode;
      this._bulkText = '';
      this._csvItems = [];
      if (this._bulkMode) { this._form = this._blankForm(); this._picker = null; }
      this._render();
    });

    root.querySelectorAll('[data-bulk-tab]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._bulkTab  = btn.dataset.bulkTab;
        this._csvItems = [];
        this._render();
      })
    );

    root.querySelector('[data-action="bulk-cancel"]')?.addEventListener('click', () => {
      this._bulkMode = false;
      this._bulkText = '';
      this._csvItems = [];
      this._render();
    });

    root.querySelector('[data-action="bulk-submit"]')?.addEventListener('click', () => this._bulkSubmit());

    root.querySelector('[data-action="csv-download"]')?.addEventListener('click', () => this._downloadTemplate());

    root.querySelector('.csv-file-input')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        this._csvItems = this._parseCSV(ev.target.result);
        this._render();
      };
      reader.readAsText(file, 'utf-8');
    });

    root.querySelector('.bulk__textarea')?.addEventListener('input', e => {
      this._bulkText = e.target.value;
    });

    root.querySelector('[data-action="open-add"]')?.addEventListener('click', () => {
      this._form      = this._blankForm();
      this._form.open = true;
      this._picker    = null;
      this._render();
    });

    root.querySelector('[data-action="toggle-done"]')?.addEventListener('click', () => {
      this._showDone = !this._showDone;
      this._render();
    });

    root.querySelectorAll('[data-action="toggle"]').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); this._toggle(btn.dataset.uid); })
    );

    root.querySelectorAll('[data-action="edit"]').forEach(btn =>
      btn.addEventListener('click', () => this._openEdit(btn.dataset.uid))
    );

    root.querySelectorAll('[data-action="delete-item"]').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); this._delete(btn.dataset.uid); })
    );

    root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      this._form   = this._blankForm();
      this._picker = null;
      this._render();
    });

    root.querySelector('[data-action="submit"]')?.addEventListener('click', () => this._submit());

    root.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (this._form.uid) this._delete(this._form.uid);
    });

    root.querySelectorAll('[data-picker]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._picker = this._picker === btn.dataset.picker ? null : btn.dataset.picker;
        this._render();
      })
    );

    root.querySelector('.picker__date')?.addEventListener('change', e => {
      this._form.due = e.target.value;
      this._picker   = null;
      this._render();
    });

    root.querySelector('[data-clear="date"]')?.addEventListener('click', () => {
      this._form.due    = '';
      this._form.remind = '';
      this._picker      = null;
      this._render();
    });

    root.querySelectorAll('[data-recur]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._form.recur = btn.dataset.recur;
        this._picker     = null;
        this._render();
      })
    );

    root.querySelectorAll('[data-remind]').forEach(btn =>
      btn.addEventListener('click', () => {
        this._form.remind = btn.dataset.remind;
        this._picker      = null;
        this._render();
      })
    );

    const inp = root.querySelector('.form__input');
    if (inp) {
      inp.addEventListener('input',   e => { this._form.title = e.target.value; });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter'  && this._form.title.trim()) this._submit();
        if (e.key === 'Escape') { this._form = this._blankForm(); this._picker = null; this._render(); }
      });
    }
  }

  // ─── Services ───────────────────────────────────────────────────────────────

  _svc(service, data) {
    const { entity_id, ...serviceData } = data;
    this._hass.callService('todo', service, serviceData, { entity_id });
  }

  _toggle(uid) {
    const item = this._items.find(i => i.uid === uid);
    if (!item) return;
    const meta       = parseMeta(item.description);
    const completing = item.status === 'needs_action';

    if (completing && meta.recur) {
      const nd  = nextDue(item.due, meta.recur);
      const svc = { entity_id: this._config.entity, item: item.summary };
      if (nd) svc.due_date = nd;
      const desc = encodeMeta(meta);
      if (desc) svc.description = desc;
      this._svc('add_item', svc);
    }

    this._svc('update_item', {
      entity_id: this._config.entity,
      item:      uid,
      status:    completing ? 'completed' : 'needs_action',
    });
  }

  _openEdit(uid) {
    const item = this._items.find(i => i.uid === uid);
    if (!item) return;
    const meta   = parseMeta(item.description);
    this._form   = { open: true, uid, title: item.summary, due: item.due ?? '', recur: meta.recur, remind: meta.remind };
    this._picker = null;
    this._render();
  }

  _submit() {
    const inputEl = this.shadowRoot.querySelector('.form__input');
    const title   = (inputEl ? inputEl.value : this._form.title).trim();
    if (!title) return;

    const { uid, due, recur, remind } = this._form;
    const desc = encodeMeta({ recur, remind });

    if (uid) {
      const data = { entity_id: this._config.entity, item: uid, rename: title };
      if (due)  data.due_date    = due;
      if (desc) data.description = desc;
      this._svc('update_item', data);
    } else {
      const data = { entity_id: this._config.entity, item: title };
      if (due)  data.due_date    = due;
      if (desc) data.description = desc;
      this._svc('add_item', data);
    }

    this._form   = this._blankForm();
    this._picker = null;
    this._render();
  }

  _bulkSubmit() {
    if (this._bulkTab === 'csv') {
      this._csvItems.forEach(it => {
        const data = { entity_id: this._config.entity, item: it.title };
        if (it.due)  data.due_date    = it.due;
        const desc = encodeMeta({ recur: it.recur, remind: it.remind });
        if (desc) data.description = desc;
        this._svc('add_item', data);
      });
    } else {
      const ta    = this.shadowRoot.querySelector('.bulk__textarea');
      const text  = ta ? ta.value : this._bulkText;
      text.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
        this._svc('add_item', { entity_id: this._config.entity, item: line });
      });
    }
    this._bulkMode = false;
    this._bulkText = '';
    this._csvItems = [];
    this._render();
  }

  _downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'aufgaben-vorlage.csv' });
    a.click();
    URL.revokeObjectURL(url);
  }

  _parseCSV(text) {
    return text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .slice(1) // skip header row
      .map(line => {
        const cols   = line.split(';').map(c => c.replace(/^"|"$/g, '').trim());
        const title  = cols[0];
        if (!title) return null;
        const due    = cols[1] || '';
        const recur  = RECUR_DE_MAP[(cols[2] || '').toLowerCase()] || '';
        const remind = REMIND_DE_MAP[(cols[3] || '').toLowerCase()] ?? '';
        return { title, due, recur, remind };
      })
      .filter(Boolean);
  }

  _delete(uid) {
    this._svc('remove_item', { entity_id: this._config.entity, item: uid });
    this._form   = this._blankForm();
    this._picker = null;
    this._render();
  }

  // ─── Styles ─────────────────────────────────────────────────────────────────

  _css() {
    return `
      :host { display: block; }

      .card {
        background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
        border-radius: var(--ha-card-border-radius, 16px);
        border: 1px solid rgba(128,128,128,0.15);
        backdrop-filter: blur(10px) saturate(1.2);
        -webkit-backdrop-filter: blur(10px) saturate(1.2);
        box-shadow: var(--ha-card-box-shadow, 0 12px 28px rgba(0,0,0,0.22));
        overflow: hidden;
        font-family: var(--primary-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      }

      /* ── Header ── */
      .header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px 10px;
      }
      .header__left  { display: flex; align-items: center; gap: 10px; }
      .header__right { display: flex; align-items: center; gap: 6px; }

      .header__icon {
        width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
        background: rgba(var(--rgb-primary-color, 3,169,244), 0.15);
        display: flex; align-items: center; justify-content: center;
      }
      .header__icon svg { width: 16px; height: 16px; fill: var(--primary-color, #03a9f4); }
      .header__title {
        font-size: 15px; font-weight: 600;
        color: var(--primary-text-color, currentColor);
      }

      .badge {
        font-size: 12px; font-weight: 600;
        color: var(--primary-color, #03a9f4);
        background: rgba(var(--rgb-primary-color, 3,169,244), 0.15);
        border-radius: 20px; padding: 2px 8px;
      }

      .icon-btn {
        width: 30px; height: 30px; border-radius: 8px;
        background: rgba(128,128,128,0.1); border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center; padding: 0;
        transition: background 0.15s;
      }
      .icon-btn svg { width: 16px; height: 16px; fill: var(--secondary-text-color, currentColor); opacity: 0.5; }
      .icon-btn:hover, .icon-btn--active { background: rgba(var(--rgb-primary-color,3,169,244), 0.12); }
      .icon-btn--active svg { fill: var(--primary-color,#03a9f4); opacity: 1; }

      .add-btn {
        width: 30px; height: 30px; border-radius: 8px;
        background: var(--primary-color, #03a9f4); border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center; padding: 0;
        transition: opacity 0.15s;
      }
      .add-btn:hover { opacity: 0.82; }
      .add-btn svg { width: 16px; height: 16px; fill: #fff; }

      /* ── View Tabs ── */
      .view-tabs {
        display: flex; gap: 4px; padding: 0 14px 10px;
      }
      .view-tab {
        padding: 4px 12px; border-radius: 20px;
        border: 1px solid rgba(128,128,128,0.18);
        background: rgba(128,128,128,0.07);
        font-size: 12px; font-weight: 500; font-family: inherit;
        color: var(--secondary-text-color, currentColor);
        cursor: pointer; transition: all 0.15s;
      }
      .view-tab:hover { border-color: var(--primary-color,#03a9f4); color: var(--primary-color,#03a9f4); }
      .view-tab--active {
        border-color: var(--primary-color,#03a9f4);
        background: rgba(var(--rgb-primary-color,3,169,244),0.12);
        color: var(--primary-color,#03a9f4);
      }

      /* ── List ── */
      .list { list-style: none; margin: 0; padding: 0 8px 8px; }

      .item {
        display: flex; align-items: center; gap: 10px;
        padding: 2px 4px; border-radius: 10px;
        transition: background 0.1s;
      }
      .item + .item { border-top: 1px solid rgba(128,128,128,0.1); border-radius: 0; }
      .item:last-child { border-radius: 0 0 8px 8px; }
      .item:first-child { border-radius: 8px 8px 0 0; }
      .item:only-child  { border-radius: 8px; }
      .item:hover { background: rgba(128,128,128,0.06); }

      .item__check {
        width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%;
        border: 2px solid rgba(128,128,128,0.35); background: transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        padding: 0; transition: all 0.15s;
      }
      .item__check svg { width: 12px; height: 12px; fill: #fff; opacity: 0; transition: opacity 0.15s; }
      .item:hover .item__check { border-color: var(--primary-color, #03a9f4); }
      .item--done .item__check {
        background: var(--primary-color, #03a9f4);
        border-color: var(--primary-color, #03a9f4);
      }
      .item--done .item__check svg { opacity: 1; }

      .item__body {
        flex: 1; min-width: 0; background: none; border: none;
        cursor: pointer; text-align: left; padding: 9px 4px;
      }
      .item__label {
        display: block; font-size: 14px; line-height: 1.4;
        color: var(--primary-text-color, currentColor); word-break: break-word;
      }
      .item--done .item__label {
        color: var(--secondary-text-color, currentColor); opacity: 0.5;
        text-decoration: line-through;
      }
      .item--overdue .item__label { color: var(--error-color, #f44336); }

      .item__meta { display: flex; gap: 5px; margin-top: 3px; flex-wrap: wrap; }

      .item__due, .item__recur {
        font-size: 11px; font-weight: 500;
        padding: 1px 6px; border-radius: 4px; white-space: nowrap;
      }
      .item__due--overdue  { color: var(--error-color,#f44336);   background: rgba(244,67,54,0.12); }
      .item__due--today    { color: var(--primary-color,#03a9f4); background: rgba(var(--rgb-primary-color,3,169,244),0.12); }
      .item__due--tomorrow { color: #ff9500;                      background: rgba(255,149,0,0.12); }
      .item__due--future   { color: var(--secondary-text-color,currentColor); opacity:0.65; background: rgba(128,128,128,0.1); }
      .item__recur         { color: var(--secondary-text-color,currentColor); opacity:0.55; background: rgba(128,128,128,0.08); }

      .item__del {
        width: 30px; height: 30px; flex-shrink: 0;
        border-radius: 6px; border: none; background: transparent;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        padding: 0; color: var(--secondary-text-color, currentColor);
        opacity: 0.3; transition: opacity 0.15s, background 0.15s, color 0.15s;
      }
      .item__del svg { width: 15px; height: 15px; fill: currentColor; }
      .item__del:hover { opacity: 1; background: rgba(244,67,54,0.12); color: var(--error-color, #f44336); }

      /* ── Empty ── */
      .empty {
        padding: 28px 20px; text-align: center; font-size: 13px;
        color: var(--secondary-text-color, currentColor); opacity: 0.5;
      }

      /* ── Bulk ── */
      .bulk {
        padding: 12px 14px 14px;
        border-top: 1px solid rgba(128,128,128,0.12);
      }
      .bulk-tabs {
        display: flex; gap: 4px; margin-bottom: 10px;
      }
      .bulk-tab {
        padding: 4px 12px; border-radius: 20px;
        border: 1px solid rgba(128,128,128,0.18);
        background: rgba(128,128,128,0.07);
        font-size: 12px; font-weight: 500; font-family: inherit;
        color: var(--secondary-text-color, currentColor);
        cursor: pointer; transition: all 0.15s;
      }
      .bulk-tab--active {
        border-color: var(--primary-color,#03a9f4);
        background: rgba(var(--rgb-primary-color,3,169,244),0.12);
        color: var(--primary-color,#03a9f4);
      }
      .bulk__textarea {
        width: 100%; box-sizing: border-box;
        background: rgba(128,128,128,0.08);
        border: 1px solid rgba(128,128,128,0.15);
        border-radius: 10px; padding: 10px 14px;
        font-size: 14px; font-family: inherit; line-height: 1.6;
        color: var(--primary-text-color, currentColor);
        outline: none; transition: border-color 0.15s;
        resize: vertical; min-height: 100px;
      }
      .bulk__textarea::placeholder { color: var(--secondary-text-color, currentColor); opacity: 0.4; }
      .bulk__textarea:focus { border-color: var(--primary-color, #03a9f4); }
      .bulk__actions {
        display: flex; gap: 8px; margin-top: 10px;
        align-items: center;
      }
      .bulk__hint {
        font-size: 11px; color: var(--secondary-text-color, currentColor);
        opacity: 0.45; margin-right: auto;
      }
      .csv-zone { display: flex; flex-direction: column; gap: 10px; }
      .csv-info {
        font-size: 13px; color: var(--secondary-text-color, currentColor);
        opacity: 0.7; margin: 0;
      }
      .csv-btns { display: flex; gap: 8px; flex-wrap: wrap; }
      .csv-upload-label { cursor: pointer; }
      .csv-preview {
        background: rgba(128,128,128,0.06);
        border: 1px solid rgba(128,128,128,0.12);
        border-radius: 10px; padding: 10px 12px;
      }
      .csv-preview__count {
        font-size: 12px; font-weight: 600;
        color: var(--primary-color,#03a9f4); display: block; margin-bottom: 8px;
      }
      .csv-preview__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .csv-preview__item {
        display: flex; align-items: center; gap: 8px;
        font-size: 13px; color: var(--primary-text-color, currentColor);
      }
      .csv-preview__title { flex: 1; min-width: 0; word-break: break-word; }
      .csv-preview__meta { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }

      /* ── Form ── */
      .form {
        padding: 12px 14px 14px;
        border-top: 1px solid rgba(128,128,128,0.12);
      }

      .form__input {
        width: 100%; box-sizing: border-box;
        background: rgba(128,128,128,0.08);
        border: 1px solid rgba(128,128,128,0.15);
        border-radius: 10px; padding: 10px 14px;
        font-size: 14px; font-family: inherit;
        color: var(--primary-text-color, currentColor);
        outline: none; transition: border-color 0.15s;
      }
      .form__input::placeholder { color: var(--secondary-text-color, currentColor); opacity: 0.4; }
      .form__input:focus { border-color: var(--primary-color, #03a9f4); }

      .form__chips { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }

      .chip {
        display: flex; align-items: center; gap: 5px;
        padding: 5px 10px; border-radius: 20px;
        border: 1px solid rgba(128,128,128,0.2);
        background: rgba(128,128,128,0.07);
        font-size: 12px; font-weight: 500; font-family: inherit;
        color: var(--secondary-text-color, currentColor);
        cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .chip svg { width: 13px; height: 13px; fill: currentColor; flex-shrink: 0; }
      .chip:hover { border-color: var(--primary-color,#03a9f4); color: var(--primary-color,#03a9f4); }
      .chip--on {
        border-color: var(--primary-color,#03a9f4);
        background: rgba(var(--rgb-primary-color,3,169,244),0.12);
        color: var(--primary-color,#03a9f4);
      }
      .chip--off { opacity: 0.35; pointer-events: none; }

      /* ── Pickers ── */
      .picker { margin-top: 8px; }
      .picker--grid { display: flex; flex-wrap: wrap; gap: 6px; }

      .picker__date {
        width: 100%; box-sizing: border-box;
        background: rgba(128,128,128,0.08);
        border: 1px solid rgba(128,128,128,0.15);
        border-radius: 10px; padding: 9px 14px;
        font-size: 14px; font-family: inherit;
        color: var(--primary-text-color, currentColor);
        outline: none;
      }
      @media (prefers-color-scheme: dark) { .picker__date { color-scheme: dark; } }

      .picker__clear {
        margin-top: 6px; background: none; border: none;
        font-size: 12px; color: var(--error-color, #f44336);
        cursor: pointer; padding: 2px 0; font-family: inherit;
      }
      .picker__clear:hover { text-decoration: underline; }

      .pill {
        padding: 5px 12px; border-radius: 20px;
        border: 1px solid rgba(128,128,128,0.2);
        background: rgba(128,128,128,0.07);
        font-size: 12px; font-weight: 500; font-family: inherit;
        color: var(--secondary-text-color, currentColor);
        cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .pill:hover { border-color: var(--primary-color,#03a9f4); color: var(--primary-color,#03a9f4); }
      .pill--on {
        border-color: var(--primary-color,#03a9f4);
        background: rgba(var(--rgb-primary-color,3,169,244),0.15);
        color: var(--primary-color,#03a9f4);
      }

      /* ── Form actions ── */
      .form__actions {
        display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;
      }

      .btn {
        padding: 8px 16px; border-radius: 8px;
        font-size: 13px; font-weight: 600; font-family: inherit;
        cursor: pointer; border: none; transition: all 0.15s;
      }
      .btn--primary { background: var(--primary-color,#03a9f4); color: #fff; }
      .btn--primary:hover { opacity: 0.82; }
      .btn--ghost {
        background: rgba(128,128,128,0.1); color: var(--secondary-text-color,currentColor);
        border: 1px solid rgba(128,128,128,0.18);
      }
      .btn--ghost:hover { background: rgba(128,128,128,0.18); }
      .btn--danger { background: rgba(244,67,54,0.1); color: var(--error-color,#f44336); margin-right: auto; }
      .btn--danger:hover { background: rgba(244,67,54,0.2); }

      /* ── Calendar ── */
      .cal { padding: 0 10px 12px; }

      .cal__nav {
        display: flex; align-items: center; justify-content: space-between;
        padding: 2px 2px 10px;
      }
      .cal__month {
        font-size: 14px; font-weight: 600;
        color: var(--primary-text-color, currentColor);
        text-transform: capitalize;
      }

      .cal__grid {
        display: grid; grid-template-columns: repeat(7, 1fr);
        gap: 2px;
      }
      .cal__wd {
        text-align: center; font-size: 11px; font-weight: 600;
        color: var(--secondary-text-color, currentColor); opacity: 0.45;
        padding: 4px 0 6px;
      }

      .cal__day {
        aspect-ratio: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 2px;
        border-radius: 8px; cursor: pointer;
        transition: background 0.12s; position: relative;
      }
      .cal__day:hover { background: rgba(128,128,128,0.08); }
      .cal__day--other { opacity: 0.2; cursor: default; pointer-events: none; }
      .cal__day--selected { background: rgba(var(--rgb-primary-color,3,169,244),0.1); }

      .cal__day-num {
        font-size: 13px; line-height: 1;
        color: var(--primary-text-color, currentColor);
      }
      .cal__day--today .cal__day-num {
        background: var(--primary-color,#03a9f4); color: #fff;
        border-radius: 50%; width: 22px; height: 22px;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px;
      }

      .cal__dot {
        width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        background: var(--primary-color,#03a9f4);
        font-size: 8px; font-weight: 700; color: #fff;
        display: flex; align-items: center; justify-content: center;
        line-height: 1;
      }
      .cal__day--overdue .cal__dot { background: var(--error-color,#f44336); }

      .cal__detail {
        margin-top: 10px;
        border-top: 1px solid rgba(128,128,128,0.12);
        padding-top: 8px;
      }
      .cal__detail-title {
        font-size: 13px; font-weight: 600;
        color: var(--primary-text-color, currentColor);
        margin-bottom: 4px; text-transform: capitalize; padding: 0 4px;
      }
      .cal__detail-list { padding-bottom: 0; }
    `;
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

customElements.define('alh-todo-card', AlhTodoCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        'alh-todo-card',
  name:        'Alltagshelfer Todo Card',
  description: 'Aufgaben mit Fälligkeitsdaten, Wiederholungen und Erinnerungen.',
});
