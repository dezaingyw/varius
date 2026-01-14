// === NAVEGACIÓN POR PESTAÑAS ===
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// === EXPANDIR CLIENTE ===
document.querySelectorAll('.list-item[data-cliente]').forEach(item => {
    item.addEventListener('click', (e) => {
        if (!e.target.closest('.item-actions')) {
            const id = item.dataset.cliente;
            const expanded = document.getElementById(`cliente-${id}-expanded`);
            expanded.classList.toggle('active');
            item.classList.toggle('expanded');
        }
    });
});

// === GUARDAR CLIENTE ===
document.getElementById('btnGuardarCliente').addEventListener('click', () => {
    const nombre = document.getElementById('nombreCliente').value;
    if (!nombre) {
        alert('Por favor ingresa el nombre.');
        return;
    }
    // Simular guardado
    document.getElementById('toast').style.display = 'block';
    setTimeout(() => {
        document.getElementById('toast').style.display = 'none';
        // Limpiar
        document.getElementById('nombreCliente').value = '';
        document.getElementById('telefonoCliente').value = '';
        document.getElementById('emailCliente').value = '';
    }, 2000);
});

// === APLICAR FILTROS (simulado) ===
document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        // En producción: filtrar listas
        console.log('Filtros aplicados');
    });
});