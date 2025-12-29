// assets/js/bank-select.js
// Reemplaza visualmente el <select id="pmMobileBank"> por un control personalizado que muestra el logo al lado del nombre.
// Mantiene el <select> original (oculto) para accesibilidad y envío de formulario.
// Modo de uso: simplemente incluir este módulo en la página que contiene el select con id="pmMobileBank".
// Las <option> pueden usar el atributo data-logo con la URL del logo. Si faltan, se usan iconos por defecto.

const BANK_SELECT_ID = 'pmMobileBank';

function injectStyles() {
    const css = `
/* estilos mínimos para el selector con logos */
.custom-bank-select {
  position: relative;
  width: 100%;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  font-size: 14px;
}
.custom-bank-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #ccc);
  background: var(--surface, #fff);
  cursor: pointer;
  user-select: none;
}
.custom-bank-trigger img {
  width: 28px;
  height: 18px;
  object-fit: contain;
  flex-shrink: 0;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.03) inset;
}
.custom-bank-trigger .cb-label {
  flex: 1;
  color: var(--text, #111);
}
.custom-bank-trigger .cb-caret {
  margin-left: 8px;
  opacity: 0.7;
}
.custom-bank-options {
  position: absolute;
  z-index: 1500;
  left: 0;
  right: 0;
  margin-top: 6px;
  max-height: 260px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--border, #ccc);
  background: var(--surface, #fff);
  box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  padding: 6px 6px;
}
.custom-bank-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}
.custom-bank-option img {
  width: 28px;
  height: 18px;
  object-fit: contain;
  flex-shrink: 0;
}
.custom-bank-option:hover,
.custom-bank-option[aria-selected="true"] {
  background: rgba(0,0,0,0.03);
}
.custom-bank-empty {
  padding: 8px;
  color: var(--muted, #666);
  font-size: 13px;
}
.hidden-native-select {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0,0,0,0) !important;
  white-space: nowrap !important;
  border: 0 !important;
}
`;
    if (!document.getElementById('bank-select-styles')) {
        const s = document.createElement('style');
        s.id = 'bank-select-styles';
        s.textContent = css;
        document.head.appendChild(s);
    }
}

function buildOptionData(optionEl) {
    const value = optionEl.value || '';
    const label = optionEl.textContent?.trim() || value;
    const logo = optionEl.dataset.logo || optionEl.getAttribute('data-logo') || null;
    return { value, label, logo };
}

function createCustomSelect(selectEl) {
    if (!selectEl) return;
    // avoid double-initialization
    if (selectEl.dataset.customized === 'true') return;
    selectEl.dataset.customized = 'true';

    injectStyles();

    // read options
    const options = Array.from(selectEl.options).map(buildOptionData);

    // wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-bank-select';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'combobox');
    wrapper.setAttribute('aria-haspopup', 'listbox');
    wrapper.setAttribute('aria-expanded', 'false');

    // trigger (selected view)
    const trigger = document.createElement('div');
    trigger.className = 'custom-bank-trigger';
    trigger.setAttribute('aria-hidden', 'false');

    const img = document.createElement('img');
    img.alt = '';
    img.style.display = 'none'; // hidden when no logo

    const labelSpan = document.createElement('span');
    labelSpan.className = 'cb-label';
    labelSpan.textContent = options[0]?.label || '';

    const caret = document.createElement('span');
    caret.className = 'cb-caret';
    caret.innerHTML = '&#9662;';

    trigger.appendChild(img);
    trigger.appendChild(labelSpan);
    trigger.appendChild(caret);

    // options list
    const list = document.createElement('div');
    list.className = 'custom-bank-options';
    list.setAttribute('role', 'listbox');
    list.style.display = 'none';
    list.tabIndex = -1;

    if (options.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'custom-bank-empty';
        empty.textContent = 'No hay bancos';
        list.appendChild(empty);
    } else {
        options.forEach((opt, idx) => {
            const item = document.createElement('div');
            item.className = 'custom-bank-option';
            item.setAttribute('role', 'option');
            item.dataset.value = opt.value;
            item.dataset.index = String(idx);
            item.tabIndex = 0;

            if (opt.logo) {
                const liImg = document.createElement('img');
                liImg.src = opt.logo;
                liImg.alt = opt.label;
                item.appendChild(liImg);
            } else {
                const placeholder = document.createElement('div');
                placeholder.style.width = '28px';
                placeholder.style.height = '18px';
                placeholder.style.background = 'linear-gradient(90deg,#eee,#f7f7f7)';
                placeholder.style.borderRadius = '2px';
                item.appendChild(placeholder);
            }

            const span = document.createElement('span');
            span.textContent = opt.label;
            item.appendChild(span);

            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                setValue(opt.value);
                close();
                selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            });

            item.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    item.click();
                } else if (ev.key === 'ArrowDown') {
                    ev.preventDefault();
                    focusNextOption(item);
                } else if (ev.key === 'ArrowUp') {
                    ev.preventDefault();
                    focusPrevOption(item);
                }
            });

            list.appendChild(item);
        });
    }

    // insert wrapper after select
    selectEl.parentNode.insertBefore(wrapper, selectEl.nextSibling);
    wrapper.appendChild(trigger);
    wrapper.appendChild(list);

    // hide native select but keep it in DOM for forms & accessibility
    selectEl.classList.add('hidden-native-select');
    selectEl.setAttribute('aria-hidden', 'true');

    // helpers
    function open() {
        list.style.display = '';
        wrapper.setAttribute('aria-expanded', 'true');
        // focus first chosen option or first
        const selIdx = selectEl.selectedIndex >= 0 ? selectEl.selectedIndex : 0;
        const item = list.querySelector(`.custom-bank-option[data-index="${selIdx}"]`) || list.querySelector('.custom-bank-option');
        if (item) item.focus();
        document.addEventListener('click', outClick);
        document.addEventListener('keydown', onKeyDown);
    }
    function close() {
        list.style.display = 'none';
        wrapper.setAttribute('aria-expanded', 'false');
        trigger.focus();
        document.removeEventListener('click', outClick);
        document.removeEventListener('keydown', onKeyDown);
    }
    function toggle() {
        if (list.style.display === 'none' || list.style.display === '') open();
        else close();
    }
    function outClick(e) {
        if (!wrapper.contains(e.target)) close();
    }

    function setValue(val) {
        selectEl.value = val;
        // update UI
        const selectedOption = Array.from(selectEl.options).find(o => o.value === val) || selectEl.options[0];
        const data = buildOptionData(selectedOption);
        if (data.logo) {
            img.src = data.logo;
            img.style.display = '';
        } else {
            img.style.display = 'none';
            img.removeAttribute('src');
        }
        labelSpan.textContent = data.label || '';
        // mark aria-selected on list items
        list.querySelectorAll('.custom-bank-option').forEach(it => {
            it.setAttribute('aria-selected', it.dataset.value === val ? 'true' : 'false');
        });
    }

    function focusNextOption(curr) {
        const all = Array.from(list.querySelectorAll('.custom-bank-option'));
        const idx = all.indexOf(curr);
        if (idx >= 0 && idx < all.length - 1) {
            all[idx + 1].focus();
        }
    }
    function focusPrevOption(curr) {
        const all = Array.from(list.querySelectorAll('.custom-bank-option'));
        const idx = all.indexOf(curr);
        if (idx > 0) {
            all[idx - 1].focus();
        } else {
            trigger.focus();
        }
    }

    function onKeyDown(ev) {
        if (ev.key === 'Escape') {
            close();
            return;
        }
        // if combobox focused and arrow down/up pressed, open and focus
        if (ev.key === 'ArrowDown' && !wrapper.classList.contains('open')) {
            open();
            ev.preventDefault();
            return;
        }
    }

    // interactions
    trigger.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggle();
    });

    trigger.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
        } else if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            open();
        }
    });

    // reflect native select changes into custom UI (useful for resets/programmatic changes)
    selectEl.addEventListener('change', () => {
        const val = selectEl.value;
        setValue(val);
    });

    // initialize displayed value
    setValue(selectEl.value || (selectEl.options[0] && selectEl.options[0].value) || '');

    // expose for debugging
    selectEl.__customBankSelect = { wrapper, trigger, list, setValue, open, close };
}

// keyboard helpers for when focus is on wrapper
function attachGlobalInit() {
    const sel = document.getElementById(BANK_SELECT_ID);
    if (!sel) return;
    createCustomSelect(sel);
}

// wait for DOM ready (module may load before modal markup)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachGlobalInit);
} else {
    attachGlobalInit();
}