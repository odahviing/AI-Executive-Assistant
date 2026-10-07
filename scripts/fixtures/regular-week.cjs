// Test data builder: emits only the complete regular-week storage contract.
const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function regularWeek(workdays, hoursStart='09:00', hoursEnd='17:00', windows={}) {
  return Object.fromEntries(days.map(day => [day, workdays.includes(day)
    ? {...(windows[day] ?? {hoursStart,hoursEnd})} : null]));
}
module.exports = {regularWeek};
