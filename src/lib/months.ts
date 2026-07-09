export const MONTHS = [
  "Январь","Февраль","Март","Апрель","Май","Июнь",
  "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь",
];
export const MONTHS_SHORT = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
export const daysInMonth = (year: number, month1: number) => new Date(year, month1, 0).getDate();
export const fmt = (n: number) => (n === 0 ? "—" : new Intl.NumberFormat("ru-RU").format(n));

// "Сегодня" в часовом поясе Актау (Asia/Aqtau). Возвращает YYYY-MM-DD.
export const todayAqtauISO = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aqtau" }).format(new Date());

export const todayAqtauParts = () => {
  const [y, mo, d] = todayAqtauISO().split("-").map(Number);
  return { year: y, month: mo, day: d };
};
