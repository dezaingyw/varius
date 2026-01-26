// calendar.js — módulo ES para Calendario de Cierre de Caja
// Exporta CashClosureCalendar
export class CashClosureCalendar {
    constructor(container, opts = {}) {
        this.container = container;
        this.opts = Object.assign({ locale: 'es', firstDay: 0 }, opts);
        this.active = new Date(); // fecha activa para el mes mostrado
        this.closures = {}; // mapa date -> closure
        this.selection = { start: null, end: null };
        this.rangeMode = false;
        this._buildUI();
        this._bindUI();
        this.render();
    }

    // Construye elementos internos y referencia
    _buildUI() {
        this.grid = this.container.querySelector('#cal-grid');
        this.titleEl = this.container.querySelector('#cal-title');
        this.detailsPanel = this.container.querySelector('#cal-details');
        this.detailsTitle = this.container.querySelector('#details-title');
        this.detailsStatus = this.container.querySelector('#details-status');
        this.detailsContent = this.container.querySelector('#details-content');

        // track active cell for week/month operations
        this._activeCellDate = null;
    }

    // Listener general para clicks en celdas
    _bindUI() {
        this.grid.addEventListener('click', (ev) => {
            const cell = ev.target.closest('.cal-day');
            if (!cell) return;
            const date = cell.dataset.date;
            if (!date) return;
            this._onDayClick(date, ev);
        });
    }

    // Cargar cierres (array de objetos)
    loadClosures(list) {
        this.closures = {}; // reset
        (list || []).forEach((c) => {
            this.closures[c.date] = c;
        });
        this.render();
    }

    // Habilitar/deshabilitar modo rango (checkbox externo)
    enableRangeMode(flag = true) {
        this.rangeMode = !!flag;
    }

    // Navegación simple
    prevMonth() { this.active.setMonth(this.active.getMonth() - 1); this.render(); }
    nextMonth() { this.active.setMonth(this.active.getMonth() + 1); this.render(); }
    goToToday() { this.active = new Date(); this.render(); }

    // Selecciona la semana que contiene la "active" (o primera seleccionada)
    selectWeekFromActive() {
        // tomar una fecha activa
        const base = this._activeCellDate ? new Date(this._activeCellDate) : new Date(this.active);
        const dow = base.getDay(); // 0..6 (dom..sab) según locale inmutable en opts
        const start = new Date(base); start.setDate(base.getDate() - dow);
        const end = new Date(start); end.setDate(start.getDate() + 6);
        this.selectRange(start, end);
    }

    // Seleccionar mes visible
    selectMonthFromActive() {
        const y = this.active.getFullYear(), m = this.active.getMonth();
        const start = new Date(y, m, 1);
        const end = new Date(y, m + 1, 0);
        this.selectRange(start, end);
    }

    // Selección programática de rango (Date o string)
    selectRange(a, b) {
        const s = (a instanceof Date) ? this._toISO(a) : a;
        const e = (b instanceof Date) ? this._toISO(b) : b;
        this.selection.start = s;
        this.selection.end = e;
        this._renderSelection();
        this._showDetailsForDate(s);
    }

    // Click en día
    _onDayClick(dateISO, ev) {
        this._activeCellDate = dateISO;
        if (this.rangeMode || ev.shiftKey) {
            // Si no hay inicio, setear start, luego set end
            if (!this.selection.start || (this.selection.start && this.selection.end)) {
                this.selection.start = dateISO;
                this.selection.end = null;
            } else {
                // establecer end entre start y clicked
                const start = new Date(this.selection.start);
                const end = new Date(dateISO);
                if (start > end) {
                    this.selection.start = this._toISO(end);
                    this.selection.end = this._toISO(start);
                } else {
                    this.selection.end = this._toISO(end);
                }
            }
        } else {
            // modo normal: seleccionar solo un día
            this.selection.start = dateISO;
            this.selection.end = dateISO;
        }
        this._renderSelection();
        this._showDetailsForDate(dateISO);
    }

    // Refresca detalles (útil para botón)
    refreshDetails() {
        if (this.selection.start) this._showDetailsForDate(this.selection.start);
    }

    // Mostrar detalles del día en el panel lateral
    _showDetailsForDate(dateISO) {
        const closure = this.closures[dateISO];
        this.detailsPanel.classList.remove('hidden');
        const d = new Date(dateISO);
        const formatted = d.toLocaleDateString(this.opts.locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        this.detailsTitle.textContent = formatted;
        if (!closure) {
            this.detailsStatus.innerHTML = `<span class="small-muted">Sin cierre</span>`;
            this.detailsContent.innerHTML = `<p class="small-muted">No se registró cierre para este día.</p>`;
            return;
        }
        const statusBadge = closure.status === 'done'
            ? `<span class="badge-closure" style="background:linear-gradient(180deg,#10b981,#059669);">REALIZADO</span>`
            : `<span class="badge-closure" style="background:linear-gradient(180deg,#ef4444,#c0262e);">PENDIENTE</span>`;
        this.detailsStatus.innerHTML = statusBadge;

        // Totales (si existen)
        const totals = closure.totals || {};
        const totalsHtml = `
      <div class="details-totals">
        <div class="total-pill">Bs: <strong>${this._formatNumber(totals.bs || 0)}</strong></div>
        <div class="total-pill">USD: <strong>${this._formatNumber(totals.usd || 0)}</strong></div>
      </div>
    `;

        // Movimientos
        const movs = (closure.movements || []);
        let movHtml = '';
        if (movs.length === 0) {
            movHtml = `<p class="small-muted">No hay movimientos registrados.</p>`;
        } else {
            movHtml = `<ul class="movements-list">` + movs.map(m => `
        <li class="mov-item">
          <div>
            <div style="font-weight:700">${m.type} — ${m.method} <span class="small-muted">(${m.seller ? m.seller : '-'})</span></div>
            <div class="mov-meta">${m.time} · ${m.rider ? 'Motorizado: ' + m.rider : ''} ${m.note ? '· ' + m.note : ''}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:800">${this._formatNumber(m.amount)}</div>
          </div>
        </li>
      `).join('') + `</ul>`;
        }

        this.detailsContent.innerHTML = totalsHtml + movHtml;
    }

    // Render del mes actual
    render() {
        // clear grid
        this.grid.innerHTML = '';
        const year = this.active.getFullYear();
        const month = this.active.getMonth();
        // title
        this.titleEl.textContent = this.active.toLocaleDateString(this.opts.locale, { month: 'long', year: 'numeric' });

        // calcular primer día de la semana que aparece en la grilla
        const firstOfMonth = new Date(year, month, 1);
        const startDow = (firstOfMonth.getDay() - this.opts.firstDay + 7) % 7;
        const gridStart = new Date(firstOfMonth);
        gridStart.setDate(firstOfMonth.getDate() - startDow);

        // crear 6 semanas (6*7 = 42 días, suficiente)
        for (let i = 0; i < 42; i++) {
            const d = new Date(gridStart);
            d.setDate(gridStart.getDate() + i);
            const iso = this._toISO(d);
            const el = document.createElement('div');
            el.className = 'cal-day';
            if (d.getMonth() !== month) el.classList.add('cal-day--other-month');
            el.setAttribute('role', 'gridcell');
            el.dataset.date = iso;

            // fecha num y contenido
            el.innerHTML = `
        <div class="date-num">${d.getDate()}</div>
        <div class="mini small-muted">${d.toLocaleDateString(this.opts.locale, { month: 'short' })}</div>
        <div class="closure-badges"></div>
      `;

            // marcar si hay cierre
            const closure = this.closures[iso];
            if (closure) {
                el.classList.add('has-closure', closure.status === 'done' ? 'done' : 'pending');
                const badge = document.createElement('div');
                badge.className = 'badge-closure';
                badge.textContent = closure.status === 'done' ? 'CERRADO' : 'PENDIENTE';
                el.querySelector('.closure-badges').appendChild(badge);

                // pequeño total (Bs) si existe
                if (closure.totals && typeof closure.totals.bs !== 'undefined') {
                    const mini = document.createElement('div');
                    mini.className = 'mini';
                    mini.textContent = 'Bs ' + this._formatNumber(closure.totals.bs);
                    el.querySelector('.closure-badges').appendChild(mini);
                }
            }

            this.grid.appendChild(el);
        }

        // aplicar selección previa
        this._renderSelection();
    }

    // Renderiza la selección visual (start..end)
    _renderSelection() {
        // limpiar selects
        this.grid.querySelectorAll('.cal-day').forEach(node => {
            node.classList.remove('selected', 'in-range');
        });
        if (!this.selection.start) return;
        const start = new Date(this.selection.start);
        const end = this.selection.end ? new Date(this.selection.end) : new Date(this.selection.start);
        // asegurar orden
        if (start > end) { const s = start; start = end; end = s; }
        this.grid.querySelectorAll('.cal-day').forEach(node => {
            const d = new Date(node.dataset.date);
            if (d >= start && d <= end) {
                node.classList.add('in-range');
            }
            // marcar extremo como selected
            if (node.dataset.date === this.selection.start || node.dataset.date === this.selection.end) {
                node.classList.add('selected');
            }
        });
    }

    // Util helpers
    _toISO(d) {
        const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        return date.toISOString().slice(0, 10);
    }

    _formatNumber(n) {
        if (typeof n !== 'number') n = Number(n) || 0;
        return n.toLocaleString(this.opts.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
}