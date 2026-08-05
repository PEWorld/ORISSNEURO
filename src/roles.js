// Кто есть кто. Владелец видит все модели и параметры, креатор — только
// фиксированный пресет GPT Image 2 и кнопку отправки кадра на согласование.
const ids = (name) =>
  (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const owners = () => ids('ALLOWED_USER_IDS');
export const creators = () => ids('CREATOR_USER_IDS');

export function roleOf(userId) {
  const id = String(userId);
  if (owners().includes(id)) return 'owner';
  if (creators().includes(id)) return 'creator';
  // Пустой список владельцев = режим «ещё не настроено», пускаем всех как владельцев.
  if (!owners().length && !creators().length) return 'owner';
  return null;
}

// Куда креатор отправляет кадры на согласование.
export function approvalChatId() {
  return process.env.OWNER_CHAT_ID || owners()[0] || null;
}
