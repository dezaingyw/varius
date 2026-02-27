// SOLO maneja el input de teléfono y el selector de operadora. NO EMAIL NI EDAD

const VENEZUELA_OPERATORS = [
    { value: '0412', label: '0412' },
    { value: '0414', label: '0414' },
    { value: '0416', label: '0416' },
    { value: '0424', label: '0424' },
    { value: '0426', label: '0426' },
    { value: '0212', label: '0212' },
    { value: 'other', label: 'Otro' }
];

// Crea el <select> para operadora solo si no existe
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

// Organiza input y select juntos en la .form-row del teléfono
function enhanceContactLayout() {
    const phoneInput = document.getElementById('cust_phone');
    if (!phoneInput) return;

    // Si ya está el <select> dentro del mismo .form-row, no hagas nada
    if (document.getElementById('cust_operator') && document.getElementById('cust_operator').parentElement === phoneInput.parentElement) {
        return;
    }

    const operator = createOperatorSelectIfMissing();
    operator.classList.add('operator-select');
    phoneInput.classList.add('phone-input-adj');

    // Busca la form-row para usar como contenedor
    const phoneRow = phoneInput.closest('.form-row') || phoneInput.parentElement;

    // Elimina el select si está en otro lado
    if (operator.parentElement && operator.parentElement !== phoneRow) {
        operator.parentElement.removeChild(operator);
    }

    // Crea un WRAPPER solo si aún no se ha agrupado
    let controls = phoneRow.querySelector('.field-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'field-controls';
        const label = phoneRow.querySelector('label');
        if (label) label.after(controls);
        else phoneRow.insertBefore(controls, phoneRow.firstChild);
    } else {
        // Limpia controles para evitar duplicados
        controls.innerHTML = '';
    }

    // Agrega el select y luego el input, en ese orden
    controls.appendChild(operator);
    controls.appendChild(phoneInput);

    if (!phoneInput.placeholder) phoneInput.placeholder = 'Ej: 1234567';
    phoneInput.setAttribute('inputmode', 'numeric');
    phoneInput.setAttribute('autocomplete', 'tel');
}

// Ejecuta siempre tras cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(enhanceContactLayout, 150);
});

export { enhanceContactLayout };