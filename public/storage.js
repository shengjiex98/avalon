// The browser's durable session keys. Keeping every key here makes storage a
// boundary instead of ambient state spread through rendering and transport.

export function createStore(storage = localStorage) {
  const store = {
    get name() { return storage.getItem('avalon.name') ?? ''; },
    set name(value) { storage.setItem('avalon.name', value); },
    get server() { return storage.getItem('avalon.server'); },
    set server(value) {
      if (value) storage.setItem('avalon.server', value);
      else storage.removeItem('avalon.server');
    },
    seatsFor(code) {
      try { return JSON.parse(storage.getItem(`avalon.seats.${code}`)) ?? []; }
      catch { return []; }
    },
    nameFor(code, playerId) {
      return store.seatsFor(code).find((seat) => seat.id === playerId)?.name ?? store.name;
    },
    setSeats: (code, seats) => storage.setItem(`avalon.seats.${code}`, JSON.stringify(seats)),
    clearSeats: (code) => storage.removeItem(`avalon.seats.${code}`),
    playerFor: (code) => storage.getItem(`avalon.player.${code}`),
    setPlayer: (code, id) => storage.setItem(`avalon.player.${code}`, id),
    clearPlayer: (code) => storage.removeItem(`avalon.player.${code}`),
    get room() { return storage.getItem('avalon.room'); },
    set room(code) {
      if (code) storage.setItem('avalon.room', code);
      else storage.removeItem('avalon.room');
    },
    get game() { return storage.getItem('avalon.game'); },
    set game(id) { storage.setItem('avalon.game', id); },
    get muted() { return Boolean(storage.getItem('avalon.muted')); },
    set muted(value) { storage.setItem('avalon.muted', value ? '1' : ''); },
    get testMode() { return Boolean(storage.getItem('avalon.test')); },
    set testMode(value) { storage.setItem('avalon.test', value ? '1' : ''); },
    set lang(value) { storage.setItem('avalon.lang', value); },
  };
  return store;
}
