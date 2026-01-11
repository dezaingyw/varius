// Comportamiento simple y práctico para input de precio (formato: miles '.' y decimal ',')
// - Inicializa el campo con "00,00" si está vacío.
// - Al hacer focus si el valor es "00,00" lo borra para permitir escribir libremente.
// - Mientras escribe: solo permite dígitos y una coma ',' (punto '.' se ignora y sirve solo como separador en pegado).
// - Formatea la parte entera con separador de miles '.' automáticamente.
// - Al presionar ',' se activa la parte decimal; el usuario escribe decimales libremente.
// - Al perder foco: normaliza a 2 decimales (p. ej. "15" -> "15,00"; "1,5" -> "1,50").
// - Pega valores con formatos como "1.234,56" o "1234.56" y se interpretan correctamente.
//
// Integración:
// - Incluye este archivo (o copia el initPriceInput a tu product-admin.js).
// - Llama initPriceInput('price') después de que el DOM esté listo (o se ejecuta automáticamente si encuentra el elemento).
(function () {
    function formatIntWithThousands(digits) {
        if (!digits) return '0';
        try {
            return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Number(digits));
        } catch {
            // fallback
            return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
        }
    }

    function parseAnyToNumber(s) {
        if (!s) return NaN;
        const cleaned = String(s).trim().replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '.');
        const v = parseFloat(cleaned);
        return Number.isFinite(v) ? v : NaN;
    }

    function initPriceInput(id = 'price') {
        const el = document.getElementById(id);
        if (!el) return;

        // Set initial placeholder-like value if empty
        if (!el.value) el.value = '00,00';

        // Input handler: sanitize & format
        function onInput() {
            let v = el.value || '';
            // Remove everything except digits and comma
            // Allow user to type '.' but we will strip it and reformat with thousands.
            v = v.replace(/[^\d,\.]/g, '');
            // Normalize: if there are multiple commas/dots, treat the first comma/dot as decimal separator.
            // Convert dots to nothing for parsing; keep only first comma as decimal marker.
            // Replace dots (thousands) and keep first comma
            const firstCommaIndex = Math.max(v.indexOf(','), v.indexOf('.'));
            let intPart = v;
            let decPart = '';
            if (firstCommaIndex >= 0) {
                // find the separator (comma or dot) that occurs first from left among comma/dot
                // We choose the leftmost of both if any
                // Use regex to find position:
                const mComma = v.indexOf(',');
                const mDot = v.indexOf('.');
                let sepIndex = -1;
                if (mComma === -1) sepIndex = mDot;
                else if (mDot === -1) sepIndex = mComma;
                else sepIndex = Math.min(mComma, mDot);
                intPart = v.slice(0, sepIndex);
                decPart = v.slice(sepIndex + 1).replace(/[.,]/g, ''); // remove any separators from decimals
            } else {
                intPart = v;
                decPart = '';
            }
            // Clean intPart from dots and commas (in case)
            intPart = (intPart || '').replace(/[^\d]/g, '');
            // remove leading zeros but keep single zero if empty
            if (intPart.length > 1) intPart = intPart.replace(/^0+/, '') || '0';

            const formattedInt = intPart ? formatIntWithThousands(intPart) : '';

            if (v.includes(',') || v.includes('.')) {
                // User indicated decimals mode: keep comma and whatever decimal digits typed (no auto-pad here)
                el.value = (formattedInt || '0') + ',' + decPart;
            } else {
                // No decimals typed: show formatted int and ",00" only on blur; while typing keep just the formatted int
                // However to match request: do not auto-move to decimals - keep showing integer only while typing.
                el.value = formattedInt || '0';
            }
        }

        // Keydown: allow digits, comma, dot, navigation, backspace, delete; block letters
        function onKeyDown(e) {
            const allowed = [
                'Backspace', 'ArrowLeft', 'ArrowRight', 'Delete', 'Tab', 'Home', 'End', 'Enter'
            ];
            if (allowed.includes(e.key)) return;
            if (/^[0-9]$/.test(e.key)) return;
            if (e.key === ',' || e.key === '.') return;
            // allow Ctrl/Cmd+A,C,V,X,Z shortcuts
            if (e.ctrlKey || e.metaKey) return;
            // otherwise block (letters, symbols)
            e.preventDefault();
        }

        // Paste: sanitize and attempt to parse common formats
        function onPaste(e) {
            const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
            if (!txt) return;
            e.preventDefault();
            // Try to parse as number in many formats and set formatted value
            const num = parseAnyToNumber(txt);
            if (!Number.isNaN(num)) {
                // Put formatted with decimals if present, else just integer
                const hasDecimalInTxt = /[,\.]\d+/.test(txt);
                if (hasDecimalInTxt) {
                    // format with decimals -> display with comma and decimals trimmed to what's pasted (but we will show them)
                    const parts = String(txt).trim().replace(/\s+/g, '').replace(/\./g, '').split(/,|\./);
                    const intP = parts[0] || '0';
                    const decP = parts[1] || '';
                    el.value = formatIntWithThousands(intP) + ',' + decP.replace(/\D/g, '');
                } else {
                    el.value = formatIntWithThousands(String(Math.trunc(num)));
                }
            } else {
                // fallback: keep only digits and optional comma
                const cleaned = txt.replace(/[^\d,\.]/g, '');
                el.value = cleaned;
                onInput();
            }
        }

        // Focus: if initial placeholder "00,00", clear so user can type; otherwise place caret at end
        function onFocus() {
            if (!el.value || el.value === '00,00' || el.value === '0' || el.value === '0,00') {
                el.value = '';
            } else {
                // keep existing value but move caret to end for convenience
                setTimeout(() => {
                    try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e) { }
                }, 0);
            }
        }

        // Blur: normalize to show decimals (always show two decimals)
        function onBlur() {
            let v = el.value || '';
            v = v.replace(/\s+/g, '');
            // If empty, set 00,00
            if (!v) {
                el.value = '00,00';
                return;
            }
            // If contains comma or dot, parse numeric and format to 2 decimals
            const n = parseAnyToNumber(v);
            if (!Number.isNaN(n)) {
                // Format to "es-ES" with 2 decimals
                el.value = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
                return;
            }
            // Fallback: try to split current value
            const parts = v.split(/,|\./);
            const intP = (parts[0] || '').replace(/[^\d]/g, '') || '0';
            const decP = (parts[1] || '').replace(/[^\d]/g, '').slice(0, 2);
            const formatted = formatIntWithThousands(intP) + ',' + (decP.padEnd(2, '0'));
            el.value = formatted;
        }

        // Wire events
        el.addEventListener('input', onInput);
        el.addEventListener('keydown', onKeyDown);
        el.addEventListener('paste', onPaste);
        el.addEventListener('focus', onFocus);
        el.addEventListener('blur', onBlur);

        // Initialize display once more (format existing value)
        onInput();
    }

    // Auto-init if element exists, otherwise expose the function
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initPriceInput('price'));
    } else {
        initPriceInput('price');
    }

    // Expose for manual init if needed
    window.initPriceInput = initPriceInput;
})();