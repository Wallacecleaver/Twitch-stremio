(() => {
  const element = id => document.getElementById(id);
  const dialog = element('alertUserDialog');
  const form = element('alertUserForm');
  const nameInput = element('alertUserName');
  const role = element('alertUserRole');
  const action = element('alertUserAction');
  const submit = element('alertUserSubmit');
  const status = element('alertUsersStatus');
  const rows = element('alertUsersRows');
  const activation = element('alertUserActivation');
  const code = element('alertUserCode');
  const error = element('alertUserError');
  const refresh = element('alertUsersRefresh');
  const newUser = element('alertUsersNew');
  const close = element('alertUserClose');
  const search = element('alertUsersSearch');
  const filter = element('alertUsersFilter');
  const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const actions = {
    reset: ['Générer un code', 'Ferme les sessions et génère un code valable 24 h pour choisir un nouveau mot de passe.'],
    revoke: ['Fermer les sessions', 'Déconnecte le compte de ses appareils. Ses alertes restent actives.'],
    suspend: ['Suspendre le compte', 'Déconnecte le compte et interrompt ses alertes. Sa liste de chaînes est conservée.'],
    resume: ['Réactiver le compte', 'Rétablit l’accès au compte et reprend l’envoi des prochaines alertes.'],
    grant: ['Nommer administrateur Alertes', 'Donne accès à la gestion des comptes Alertes depuis le dashboard.'],
    demote: ['Retirer le rôle administrateur', 'Retire l’accès à la gestion des alertes et ferme les sessions d’administration.'],
    delete: ['Supprimer le compte', 'Ferme toutes les sessions et supprime la liste de chaînes ainsi que les abonnements navigateur et Telegram.'],
  };
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stateOf = user => user.disabled ? 'disabled' : user.pending ? 'pending' : 'active';
  const states = { active: ['Actif', 'ok'], pending: ['À activer', 'wa'], disabled: ['Suspendu', 'ko'] };
  let users = [], owner = false, loaded = false, selected, loadVersion = 0;

  async function request(path, payload) {
    const response = await fetch(path, payload && {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      if (response.ok) window.location.assign('/admin');
      throw new Error('Impossible de joindre le serveur.');
    }
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Action impossible.');
    return data;
  }

  function render() {
    if (!loaded) return;
    const selection = filter.value;
    const query = search.value.trim().toLowerCase();
    const matching = users.filter(user => user.name.toLowerCase().includes(query)
      && (!selection || (selection === 'admin' ? user.admin : stateOf(user) === selection)));
    element('alertUsersTotal').textContent = users.length;
    element('alertUsersActive').textContent = users.filter(user => stateOf(user) === 'active').length;
    element('alertUsersPending').textContent = users.filter(user => stateOf(user) === 'pending').length;
    element('alertUsersSuspended').textContent = users.filter(user => user.disabled).length;
    status.textContent = matching.length ? '' : users.length ? 'Aucun compte ne correspond à ta recherche.' : 'Aucun compte Alertes pour le moment.';
    status.hidden = !!matching.length;
    element('alertUsersTable').hidden = !matching.length;
    rows.innerHTML = matching.map(user => {
      const [state, color] = states[stateOf(user)];
      const name = escape(user.name);
      const channels = escape(user.channels.join(', '));
      const notifications = [user.telegram ? 'Telegram' : '', user.push ? 'Navigateur (' + Number(user.push) + ')' : ''].filter(Boolean).join(' · ');
      const manage = owner || !user.admin;
      return `<tr role="row">
        <td><strong>${name}</strong>${user.admin ? '<div class="alert-user-role">Administrateur Alertes</div>' : ''}</td>
        <td><span class="pill ${color}">${state}</span></td>
        <td data-label="Chaînes"><span class="alert-user-channels" title="${channels}">${channels || '–'}</span></td>
        <td data-label="Notifications">${notifications || '–'}</td>
        <td data-label="Dernière connexion">${user.lastLogin ? date.format(user.lastLogin) : '–'}</td>
        <td>${manage ? `<button class="btn" type="button" data-alert-user="${name}" aria-label="Gérer ${name}">Gérer</button>` : '–'}</td>
      </tr>`;
    }).join('');
  }

  async function load() {
    const version = ++loadVersion;
    refresh.disabled = true;
    try {
      const data = await request('/admin/api/alerts/users');
      if (version !== loadVersion) return;
      users = data.users;
      owner = data.owner;
      loaded = true;
      newUser.disabled = false;
      render();
    } catch (e) {
      if (version !== loadVersion) return;
      status.hidden = false;
      status.textContent = e.message;
    } finally {
      if (version === loadVersion) refresh.disabled = false;
    }
  }

  function updateAction() {
    const choice = selected && actions[action.value];
    const deleting = !!selected && action.value === 'delete';
    submit.classList.toggle('pr', !deleting);
    submit.classList.toggle('danger', deleting);
    submit.disabled = !!selected && !choice;
    submit.textContent = selected ? choice?.[0] || 'Choisir une action' : 'Créer et générer le code';
    const details = action.value === 'revoke' && selected ? ' Sessions ouvertes : ' + selected.sessions + '.' : '';
    element('alertUserHint').textContent = selected ? (choice?.[1] || '') + details : 'La personne choisira son mot de passe avec un code d’activation à usage unique.';
  }

  function open(user) {
    selected = user;
    form.reset();
    action.replaceChildren(new Option('Choisir une action…', ''));
    const available = !user ? [] : user.disabled ? ['resume'] : user.pending ? ['reset', 'suspend'] : ['reset', 'revoke', 'suspend'];
    if (user && owner) available.push(user.admin ? 'demote' : 'grant');
    if (user && (owner || !user.admin)) available.push('delete');
    for (const option of available) action.add(new Option(actions[option][0], option));
    element('alertUserDialogTitle').textContent = user ? 'Gérer ' + user.name : 'Créer un compte Alertes';
    element('alertUserNameField').hidden = !!user;
    nameInput.required = !user;
    element('alertUserRoleField').hidden = !!user || !owner;
    element('alertUserActionField').hidden = !user;
    activation.hidden = error.hidden = true;
    form.hidden = false;
    code.value = '';
    element('alertUserCopyStatus').textContent = '';
    updateAction();
    dialog.showModal();
    (user ? action : nameInput).focus();
  }

  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  action.addEventListener('change', updateAction);
  refresh.addEventListener('click', load);
  newUser.addEventListener('click', () => open());
  rows.addEventListener('click', event => {
    const button = event.target.closest('[data-alert-user]');
    const user = button && users.find(item => item.name === button.dataset.alertUser);
    if (user) open(user);
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (close.disabled) event.preventDefault(); });
  dialog.addEventListener('close', () => { code.value = ''; });
  element('alertUserCopy').addEventListener('click', async () => {
    const notice = element('alertUserCopyStatus');
    try {
      await navigator.clipboard.writeText(code.value);
      notice.textContent = 'Code copié.';
    } catch {
      code.focus();
      code.select();
      notice.textContent = 'Sélection faite. Copie le code avec Ctrl+C.';
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const payload = selected ? { name: selected.name, action: action.value }
      : { name: nameInput.value, action: 'create', admin: owner && role.checked };
    if (payload.action === 'delete') {
      if (!window.confirm('Supprimer définitivement le compte « ' + selected.name + ' », sa liste de chaînes et ses abonnements ?')) return;
      payload.createdAt = selected.createdAt;
    }
    submit.disabled = close.disabled = true;
    error.hidden = true;
    try {
      const data = await request('/admin/api/alerts/users', payload);
      if (data.code) {
        element('alertUserDialogTitle').textContent = 'Code pour ' + data.name;
        element('alertUserActivationName').textContent = data.name;
        code.value = data.code;
        form.hidden = true;
        activation.hidden = false;
        code.focus();
      } else dialog.close();
      await load();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      close.disabled = false;
      updateAction();
    }
  });
  window.loadAlertUsers = load;
})();
