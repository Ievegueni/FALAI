// Falaí - site. Só o essencial: menu no telemóvel, link do painel e pedido de demonstração.

// ── Preencher antes de publicar ──────────────────────────────────────────────
const CONFIG = {
  // Endereço do painel (CRM) para o botão "Entrar". Vazio = o botão não aparece.
  crmUrl: '',
  // Email que recebe os pedidos de demonstração (abre o programa de email do visitante).
  contactEmail: 'geral@comunica.ao',
};

// Menu no telemóvel
const nav = document.getElementById('nav');
const menuBtn = document.querySelector('[data-menu]');
menuBtn.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
nav.querySelectorAll('.nav-links a, .nav-cta a').forEach((a) =>
  a.addEventListener('click', () => {
    nav.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }),
);

// "Entrar" vai para o painel; sem URL configurado, esconde-se
document.querySelectorAll('[data-login]').forEach((a) => {
  if (CONFIG.crmUrl) a.href = CONFIG.crmUrl;
  else a.hidden = true;
});

document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));

// Pedido de demonstração: sem servidor, abre um email já preenchido.
// ponytail: mailto - trocar por um POST para a API quando houver um endpoint de leads.
const form = document.querySelector('[data-contact]');
const note = document.querySelector('[data-form-note]');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const d = Object.fromEntries(new FormData(form));
  if (!CONFIG.contactEmail) {
    note.textContent = 'Formulário ainda sem email de destino - contacte-nos directamente.';
    return;
  }
  const body = [`Nome: ${d.nome}`, `Empresa: ${d.empresa}`, `Email: ${d.email}`, `Telefone: ${d.telefone || '-'}`, `Agentes: ${d.agentes}`].join('\n');
  window.location.href = `mailto:${CONFIG.contactEmail}?subject=${encodeURIComponent(`Demonstração Falaí - ${d.empresa}`)}&body=${encodeURIComponent(body)}`;
  note.textContent = 'Abrimos o seu programa de email com o pedido preenchido. Basta enviar.';
});
