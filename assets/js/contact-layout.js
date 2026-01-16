// Pequeño módulo que mejora el layout de los campos de contacto sin cambiar IDs ni listeners existentes.
// Cargar este script después de pedidos-data.js

const VENEZUELA_OPERATORS = [
    { value: '0412', label: '0412' },
    { value: '0414', label: '0414' },
    { value: '0416', label: '0416' },
    { value: '0424', label: '0424' },
    { value: '0426', label: '0426' },
    { value: '0212', label: '0212' },
    { value: 'other', label: 'Otro' }
];

const COMMON_EMAIL_DOMAINS = [
    'gmail.com',
    'hotmail.com',
    'yahoo.com',
    'outlook.com',
    'live.com'
];

function createOperatorSelectIfMissing() {
    let sel = document.getElementById('cust_operator');
    if (sel) return sel;
    sel = document.createElement('select');
    sel.id = 'cust_operator';
    sel.name = 'operator';
    sel.setAttribute('aria-label', 'Operadora telefónica');
    VENEZUELA_OPERATORS.forEach(op => {
        const o = document.createElement('option');
        o.value = op.value;
        o.textContent = op.label;
        sel.appendChild(o);
    });
    return sel;
}

function createEmailDomainSelectIfMissing() {
    let sel = document.getElementById('cust_email_domain');
    if (sel) return sel;
    sel = document.createElement('select');
    sel.id = 'cust_email_domain';
    sel.name = 'email_domain';
    sel.setAttribute('aria-label', 'Extensión del correo');
    COMMON_EMAIL_DOMAINS.forEach(d => {
        const o = document.createElement('option');
        o.value = d;
        o.textContent = d;
        sel.appendChild(o);
    });
    return sel;
}

function wrapControlsIntoRow(rowEl, controlsEl) {
    // rowEl: .form-row (label + input)
    // controlsEl: container con elementos de control ya preparados
    rowEl.classList.add('field-inline'); // para CSS
    let controls = rowEl.querySelector('.field-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'field-controls';
        // insert controls after label if label exists
        const label = rowEl.querySelector('label');
        if (label) label.after(controls);
        else rowEl.insertBefore(controls, rowEl.firstChild);
    }
    // append children of controlsEl into controls (avoid duplicates)
    Array.from(controlsEl.children || []).forEach(child => {
        if (!controls.contains(child)) controls.appendChild(child);
    });
}

function enhanceContactLayout() {
    const phoneInput = document.getElementById('cust_phone');
    if (phoneInput) {
        const operator = createOperatorSelectIfMissing();
        operator.classList.add('operator-select');
        phoneInput.classList.add('phone-input-adj');

        // If the operator select isn't in DOM, insert it (we will move into wrapper anyway)
        if (!operator.parentElement) {
            // create a temp container
            const tmp = document.createElement('div');
            tmp.appendChild(operator);
            tmp.appendChild(phoneInput);
            const phoneRow = phoneInput.closest('.form-row') || phoneInput.parentElement;
            if (phoneRow) wrapControlsIntoRow(phoneRow, tmp);
        } else {
            // operator exists somewhere: ensure both are wrapped
            const phoneRow = phoneInput.closest('.form-row') || phoneInput.parentElement;
            if (phoneRow) {
                const tmp = document.createElement('div');
                tmp.appendChild(operator);
                tmp.appendChild(phoneInput);
                wrapControlsIntoRow(phoneRow, tmp);
            }
        }

        // placeholder example, claro y útil
        if (!phoneInput.placeholder) phoneInput.placeholder = 'Ej: 1234567';
        // inputmode y patrón ya están en HTML original; asegurar atributos útiles
        phoneInput.setAttribute('inputmode', 'numeric');
        phoneInput.setAttribute('autocomplete', 'tel');
    }

    const emailInput = document.getElementById('cust_email');
    if (emailInput) {
        const domain = createEmailDomainSelectIfMissing();
        domain.classList.add('email-domain-select');
        emailInput.classList.add('email-input-adj');

        // Wrap email and domain together
        const emailRow = emailInput.closest('.form-row') || emailInput.parentElement;
        if (emailRow) {
            const tmp = document.createElement('div');
            tmp.appendChild(emailInput);
            tmp.appendChild(domain);
            wrapControlsIntoRow(emailRow, tmp);
        }

        if (!emailInput.placeholder) emailInput.placeholder = 'usuario';
        emailInput.setAttribute('autocomplete', 'email');
    }

    // Small accessibility tweak: ensure labels remain associated
    // (We didn't change IDs so label[for] remains valid)
}

// Run after a short delay to let pedidos-data.js create selects if it does
document.addEventListener('DOMContentLoaded', () => {
    // Delay a bit in case pedidos-data.js runs on DOMContentLoaded too
    setTimeout(() => {
        try {
            enhanceContactLayout();
        } catch (err) {
            // fail silently - no break
            console.warn('contact-layout enhancement failed', err);
        }
    }, 100);
});

// Also expose function for manual invocation during debugging
export { enhanceContactLayout };