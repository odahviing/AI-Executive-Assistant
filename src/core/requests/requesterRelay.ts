/**
 * Shared requester-relay primitives (R1 — the close-loop is part of the spine,
 * not a mechanism beside it; R3 — whoever is waiting hears the real outcome,
 * exactly once).
 *
 * notifyRequesterOfDecision (resolver.ts) is the FULL relay for decision
 * verdicts — LLM-composed wording, owner shadow, history/outbound-tracker
 * stamps. But three other closure paths (expiry, the freeform-flag give-up,
 * the non-resolver booking cascade in closeMeetingArtifacts) each hand-rolled
 * a thin English-only copy with no leak filter: a Hebrew-speaking requester
 * got an English relay (the exact #107d class, re-grown outside the resolver),
 * and closeMeetingArtifacts could print an internal auto-generated
 * "… needs your input" row.subject verbatim into a colleague's DM.
 *
 * `relayClosureToRequester` is the ONE deterministic composer those paths now
 * share: saved recipient language, deterministic localized copy,
 * leak-filtered subject (usableRelaySubject), MPIM/DM origin-thread routing,
 * and `requester_notified_at` stamped ONLY on a confirmed ok send. Callers
 * supply the outcome-specific sentence through the shared copy catalog.
 */

import type { UserProfile } from '../../config/userProfile';
import type { RequestRow } from './types';
import { parseDetails } from './types';
import { getConnection } from '../../connections/registry';
import { getRequest, updateRequest } from '../../db/requests';
import logger from '../../utils/logger';

/**
 * v2.8.6 — filter out the auto-generated `<subkind> needs your input` phrase
 * that lands on row.subject when Sonnet didn't pass an explicit subject. That
 * phrase leaked into MPIM resolution messages as "Idan said yes on policy
 * exception needs your input" — internal jargon visible to colleagues. When
 * this returns true, the caller falls back to a generic phrase instead.
 */
function looksLikeApprovalMeta(subject: string): boolean {
  const lower = subject.trim().toLowerCase();
  return lower.endsWith('needs your input')
    || lower === 'unknown person'
    || lower === 'policy exception'
    || lower === 'duration override'
    || lower === 'lunch bump'
    || lower === 'calendar conflict';
}

// v3.3.x (Dina webinar, 2026-06-14) — a candidate subject that is phrased as a
// QUESTION is the internal approval ASK ("Can Idan find 10 minutes with Dina
// tomorrow for Zoom webinar setup?"), framed to the OWNER. Pasting it into the
// requester-facing "{owner} said yes on {X}" relay leaked that internal framing
// to Dina ("said yes on Can Idan find 10 minutes…?"). A real meeting subject is
// a noun phrase, never a question — reject question-form candidates so the relay
// falls back to a clean generic.
function looksLikeApprovalQuestion(subject: string): boolean {
  const t = subject.trim();
  if (t.endsWith('?')) return true;
  return /^(can|could|would|will|should|does|is|are|may|shall)\b/i.test(t);
}

export function usableRelaySubject(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  const s = candidate.trim();
  if (!s) return undefined;
  if (looksLikeApprovalMeta(s) || looksLikeApprovalQuestion(s)) return undefined;
  return s;
}

/**
 * v2.9.4 (#107d) → v3.5.x — the relay language is DERIVED from the requester's
 * shared person-level outbound language resolver (default English).
 * These closure notices initiate contact. Preserve known languages; only missing
 * data defaults to English. A read failure is unavailable data, not a preference.
 */
export function requesterRelayLanguage(requesterSlackId: string): string {
  try {
    // Lazy require mirrors resolver.ts — keeps db/people off this module's
    // static import graph.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonMemory, resolveOutboundLanguageForPerson } = require('../../db/people') as typeof import('../../db/people');
    return resolveOutboundLanguageForPerson(getPersonMemory(requesterSlackId)) ?? 'en';
  } catch {
    return 'unavailable';
  }
}

// Static notices share the existing relay composer. Values are quoted source
// data, never translated or interpreted; only the authored notice is localized.
// An unrecognized KNOWN language is not an English preference.
const relayCopy = {
  floating_overlap_notice: ["Your {block} on {date} overlaps \"{subject}\" and there's no free spot left inside its {start}–{end} window. I've left it in place.","מקטע {block} שלך ב{date} חופף ל\"{subject}\", ולא נותר מקום פנוי בחלון {start}–{end} שלו. השארתי אותו במקומו.","Dein Block {block} am {date} überschneidet sich mit „{subject}“. Im Zeitfenster {start}–{end} ist kein Platz mehr frei. Ich habe ihn unverändert gelassen.","Tu bloque {block} del {date} coincide con «{subject}» y no queda ningún hueco libre dentro de su intervalo {start}–{end}. Lo he dejado donde estaba.","تتداخل فترة {block} في {date} مع «{subject}»، ولا توجد مساحة شاغرة ضمن نافذتها {start}–{end}. أبقيتها في مكانها.","Твой блок {block} на {date} пересекается с «{subject}», и в его окне {start}–{end} больше нет свободного места. Я оставила его без изменений."],
  bounce_reject: ['{target} said the counter doesn\'t work{reason}. Back to you on "{subject}" — want to suggest something else, or drop it?', '{target} אמרו שההצעה לא מתאימה{reason}. לגבי "{subject}" — להציע משהו אחר או לוותר?', '{target} kann dem Gegenvorschlag nicht zustimmen{reason}. Möchten Sie für „{subject}“ etwas anderes vorschlagen oder die Anfrage beenden?', '{target} dice que la contrapropuesta no le sirve{reason}. Sobre «{subject}», ¿quieres proponer otra cosa o dejarlo?', 'قال {target} إن الاقتراح البديل لا يناسبه{reason}. بخصوص «{subject}»، هل تقترح بديلاً أم ننهي الطلب؟', '{target} сообщил, что встречное предложение не подходит{reason}. По «{subject}» предложить другой вариант или завершить запрос?'],
  bounce_time: ['{target} accepted your counter on "{subject}". No action was executed because the time needs clarification; the accepted counter is unchanged.\n{quote}', '{target} קיבלו את הצעתך לגבי "{subject}". לא בוצעה פעולה כי נדרש בירור של הזמן; ההצעה שהתקבלה לא שונתה.\n{quote}', '{target} hat Ihren Gegenvorschlag zu „{subject}“ angenommen. Wegen einer nötigen Zeitklärung wurde nichts ausgeführt; der angenommene Vorschlag bleibt unverändert.\n{quote}', '{target} aceptó tu contrapropuesta sobre «{subject}». No se ejecutó nada porque hay que aclarar la hora; la propuesta aceptada no cambia.\n{quote}', 'قبل {target} اقتراحك البديل بشأن «{subject}». لم يُنفذ أي إجراء لأن الوقت يحتاج إلى توضيح؛ الاقتراح المقبول لم يتغير.\n{quote}', '{target} принял ваше встречное предложение по «{subject}». Ничего не выполнено: время требует уточнения. Принятое предложение не изменено.\n{quote}'],
  bounce_failed: ['{target} accepted your counter on "{subject}", but I could not confirm the action completed. Check its current state before retrying; the accepted counter is unchanged.\n{quote}', '{target} קיבלו את הצעתך לגבי "{subject}", אך לא הצלחתי לאשר שהפעולה הושלמה. יש לבדוק את המצב לפני ניסיון נוסף; ההצעה שהתקבלה לא שונתה.\n{quote}', '{target} hat Ihren Gegenvorschlag zu „{subject}“ angenommen, aber der Abschluss der Aktion ist nicht bestätigt. Prüfen Sie vor einem neuen Versuch den aktuellen Stand; der Vorschlag bleibt unverändert.\n{quote}', '{target} aceptó tu contrapropuesta sobre «{subject}», pero no pude confirmar la finalización. Comprueba el estado antes de reintentar; la propuesta aceptada no cambia.\n{quote}', 'قبل {target} اقتراحك بشأن «{subject}»، لكن لم أتمكن من تأكيد اكتمال الإجراء. تحقّق من حالته قبل المحاولة مجدداً؛ الاقتراح المقبول لم يتغير.\n{quote}', '{target} принял ваше встречное предложение по «{subject}», но выполнение не подтверждено. Перед повторной попыткой проверьте состояние; принятое предложение не изменено.\n{quote}'],
  bounce_counter: ['{target} countered with {quote} on "{subject}". Approve, reject, or counter again?', '{target} הציעו את {quote} לגבי "{subject}". לאשר, לדחות או להציע חלופה?', '{target} hat für „{subject}“ Folgendes vorgeschlagen: {quote}. Zustimmen, ablehnen oder einen Gegenvorschlag machen?', '{target} propuso {quote} para «{subject}». ¿Aceptar, rechazar o proponer otra opción?', 'قدم {target} اقتراحاً بديلاً: {quote} بشأن «{subject}». هل توافق أم ترفض أم تقدم بديلاً؟', '{target} предложил {quote} по «{subject}». Одобрить, отклонить или предложить другой вариант?'],
  auto_counter: ['{target} countered "{subject}" to {time} — same week, within your rules, so I moved it. Say the word if you\'d rather I hadn\'t.', '{target} הציעו להעביר את "{subject}" ל{time} — באותו שבוע ובהתאם לכללים שלך, ולכן העברתי. עדכנו אם רציתם אחרת.', '{target} hat für „{subject}“ {time} vorgeschlagen: dieselbe Woche und innerhalb Ihrer Regeln, daher wurde der Termin verschoben. Sagen Sie Bescheid, falls Sie etwas anderes wünschen.', '{target} propuso {time} para «{subject}»: la misma semana y dentro de tus reglas, así que lo cambié. Avísame si prefieres otra cosa.', 'اقترح {target} نقل «{subject}» إلى {time} ضمن الأسبوع نفسه وقواعدك، فنقلته. أخبرني إذا كنت تفضّل غير ذلك.', '{target} предложил перенести «{subject}» на {time}: та же неделя, в рамках ваших правил, поэтому встреча перенесена. Сообщите, если предпочитаете иначе.'],
  counter_ask: ['{target} can\'t do {time}, and offers {value} for "{subject}". Their reply: "{quote}". Which exact date and time should I use?', '{target} לא יכולים ב{time}, ומציעים {value} עבור "{subject}". התשובה המקורית: "{quote}". באיזה תאריך ושעה מדויקים להשתמש?', '{target} kann nicht um {time} und bietet {value} für „{subject}“ an. Originalantwort: „{quote}“. Welches genaue Datum und welche Zeit soll ich verwenden?', '{target} no puede a las {time} y ofrece {value} para «{subject}». Su respuesta: «{quote}». ¿Qué fecha y hora exactas uso?', 'لا يناسب {target} الموعد {time} ويقترح {value} لـ«{subject}». رده: «{quote}». ما التاريخ والوقت المحددان اللذان أستخدمهما؟', '{target} не может в {time} и предлагает {value} для «{subject}». Ответ: «{quote}». Какую точную дату и время использовать?'],
  approval_reminder: ['Still waiting on your call here: "{subject}". Closing it on {time} if I don\'t hear back.', 'עדיין ממתינה להחלטתך לגבי "{subject}". אסגור את הבקשה ב{time} אם לא תתקבל תשובה.', 'Ihre Entscheidung zu „{subject}“ steht noch aus. Ohne Antwort schließe ich die Anfrage am {time}.', 'Sigo esperando tu decisión sobre «{subject}». Cerraré la solicitud el {time} si no recibo respuesta.', 'ما زلت أنتظر قرارك بشأن «{subject}». سأغلق الطلب في {time} إن لم أتلق رداً.', 'Ещё ожидается ваше решение по «{subject}». Без ответа запрос будет закрыт {time}.'],
  move_ok: ['{target} is fine with the moved time for "{subject}" ({time}).', '{target} אישרו שהמועד החדש של "{subject}" מתאים ({time}).', '{target} ist mit der neuen Zeit für „{subject}“ einverstanden ({time}).', '{target} acepta el nuevo horario de «{subject}» ({time}).', 'وافق {target} على الموعد الجديد لـ«{subject}» ({time}).', '{target} согласен с новым временем «{subject}» ({time}).'],
  move_done: ['{target} confirmed, moved "{subject}" to {time}.', '{target} אישרו, והעברתי את "{subject}" ל{time}.', '{target} hat bestätigt; „{subject}“ wurde auf {time} verschoben.', '{target} confirmó; he cambiado «{subject}» a {time}.', 'أكد {target}، ونقلت «{subject}» إلى {time}.', '{target} подтвердил; «{subject}» перенесена на {time}.'],
  move_checking: ['{target} is checking on "{subject}" — nothing decided yet, so I\'m keeping the current time. {status}', '{target} בודקים לגבי "{subject}" — עדיין אין החלטה, ולכן המועד הנוכחי נשאר. {status}', '{target} prüft „{subject}“. Es ist noch nichts entschieden; die aktuelle Zeit bleibt bestehen. {status}', '{target} está comprobando «{subject}». No hay decisión todavía, así que mantengo la hora actual. {status}', 'يتحقق {target} من «{subject}». لم يُتخذ قرار بعد، لذا أبقي الموعد الحالي. {status}', '{target} уточняет насчёт «{subject}». Решения пока нет; текущее время сохраняется. {status}'],
  reminder_already: ['The one reminder was already sent; this will close at the existing deadline if there is no answer.', 'התזכורת היחידה כבר נשלחה; הבקשה תיסגר במועד שנקבע אם לא תתקבל תשובה.', 'Die einmalige Erinnerung wurde bereits gesendet. Ohne Antwort wird die Anfrage zur bestehenden Frist geschlossen.', 'Ya se envió el único recordatorio. Sin respuesta, se cerrará en el plazo previsto.', 'أُرسل التذكير الوحيد بالفعل. سيُغلق الطلب في الموعد المحدد إذا لم يصل رد.', 'Единственное напоминание уже отправлено. Без ответа запрос закроется в установленный срок.'],
  reminder_tomorrow: ['If I don\'t hear back I\'ll nudge once tomorrow.', 'אם לא תתקבל תשובה, אזכיר פעם אחת מחר.', 'Falls keine Antwort kommt, erinnere ich morgen einmal.', 'Si no recibo respuesta, enviaré un recordatorio mañana.', 'إن لم أتلق رداً، سأرسل تذكيراً واحداً غداً.', 'Если ответа не будет, завтра отправлю одно напоминание.'],
  move_declined: ['{target} declined moving "{subject}". Keeping the original time. Reply preview: "{quote}"', '{target} דחו את העברת "{subject}". המועד המקורי נשאר. תשובה מקורית: "{quote}"', '{target} hat die Verschiebung von „{subject}“ abgelehnt. Die ursprüngliche Zeit bleibt. Originalantwort: „{quote}“', '{target} rechazó cambiar «{subject}». Mantengo la hora original. Respuesta original: «{quote}»', 'رفض {target} نقل «{subject}». يبقى الموعد الأصلي. الرد الأصلي: «{quote}»', '{target} отказался от переноса «{subject}». Исходное время сохраняется. Исходный ответ: «{quote}»'],
  moved_declined: ['{target} says the time I moved "{subject}" to ({time}) doesn\'t work — I\'d shifted it to clear a clash. Want me to move it back to {old} (back into the clash), or find another slot? Reply preview: "{quote}"', '{target} אמרו שהמועד שאליו העברתי את "{subject}" ({time}) לא מתאים. הזזתי אותו בגלל התנגשות. להחזיר ל{old} (עם ההתנגשות) או למצוא מועד אחר? תשובה מקורית: "{quote}"', '{target} kann zur neuen Zeit von „{subject}“ ({time}) nicht. Die Verschiebung sollte einen Konflikt lösen. Zurück auf {old} (mit Konflikt) oder eine andere Zeit suchen? Originalantwort: „{quote}“', '{target} dice que el nuevo horario de «{subject}» ({time}) no le va bien. Lo cambié para evitar un conflicto. ¿Volver a {old} (con el conflicto) o buscar otro horario? Respuesta original: «{quote}»', 'قال {target} إن الموعد الجديد لـ«{subject}» ({time}) لا يناسبه. نقلته لتجنب تعارض. هل أعيده إلى {old} (مع التعارض) أم أبحث عن موعد آخر؟ الرد الأصلي: «{quote}»', '{target} не подходит новое время «{subject}» ({time}). Перенос устранял конфликт. Вернуть на {old} (с конфликтом) или найти другое время? Исходный ответ: «{quote}»'],
  move_observed: ['I tried to move "{subject}". A read-only check confirms the requested time is now on the calendar, but does not establish which attempt produced it. I have not repeated the action.', 'ניסיתי להעביר את "{subject}". בדיקה לקריאה בלבד אישרה שהמועד המבוקש נמצא ביומן, אך לא איזו פעולה יצרה אותו. לא חזרתי על הפעולה.', 'Ich habe versucht, „{subject}“ zu verschieben. Eine Leseprüfung bestätigt die gewünschte Zeit im Kalender, aber nicht, welcher Versuch sie bewirkt hat. Die Aktion wurde nicht wiederholt.', 'Intenté cambiar «{subject}». Una consulta confirma la hora solicitada en el calendario, pero no qué intento la produjo. No he repetido la acción.', 'حاولت نقل «{subject}». أكد تحقق للقراءة فقط وجود الموعد المطلوب في التقويم، لكنه لا يثبت أي محاولة أنتجته. لم أكرر الإجراء.', 'Была попытка перенести «{subject}». Проверка без изменений подтверждает нужное время в календаре, но не устанавливает, какая попытка его создала. Действие не повторялось.'],
  move_not_observed: ['I tried to move "{subject}", but a read-only check did not find the requested calendar state. I have not repeated the action, and no further automatic check is pending.', 'ניסיתי להעביר את "{subject}", אך בדיקה לקריאה בלבד לא מצאה את המצב המבוקש ביומן. לא חזרתי על הפעולה ואין בדיקה אוטומטית נוספת בהמתנה.', 'Ich habe versucht, „{subject}“ zu verschieben. Eine Leseprüfung fand den gewünschten Kalenderzustand nicht. Die Aktion wurde nicht wiederholt; keine weitere automatische Prüfung steht aus.', 'Intenté cambiar «{subject}», pero una consulta no encontró el estado solicitado en el calendario. No he repetido la acción y no hay otra comprobación automática pendiente.', 'حاولت نقل «{subject}»، لكن تحققاً للقراءة فقط لم يجد الحالة المطلوبة في التقويم. لم أكرر الإجراء ولا يوجد تحقق آلي آخر قيد الانتظار.', 'Была попытка перенести «{subject}», но проверка без изменений не обнаружила нужного состояния календаря. Действие не повторялось, дальнейшая автоматическая проверка не запланирована.'],
  move_unknown: ['I tried to move "{subject}", but could not confirm whether it worked. I have not repeated the action, and no further automatic check is pending.', 'ניסיתי להעביר את "{subject}", אך לא הצלחתי לאשר שזה הצליח. לא חזרתי על הפעולה ואין בדיקה אוטומטית נוספת בהמתנה.', 'Ich habe versucht, „{subject}“ zu verschieben, konnte den Erfolg aber nicht bestätigen. Die Aktion wurde nicht wiederholt; keine weitere automatische Prüfung steht aus.', 'Intenté cambiar «{subject}», pero no pude confirmar el resultado. No he repetido la acción y no hay otra comprobación automática pendiente.', 'حاولت نقل «{subject}» لكن لم أتمكن من تأكيد نجاحه. لم أكرر الإجراء ولا يوجد تحقق آلي آخر قيد الانتظار.', 'Была попытка перенести «{subject}», но результат не подтверждён. Действие не повторялось, дальнейшая автоматическая проверка не запланирована.'],
  reminder_content: ['{target} asked me to remind you: {quote}', '{target} ביקש להזכיר לך: {quote}', '{target} hat mich gebeten, Sie zu erinnern: {quote}', '{target} me pidió que te recordara: {quote}', 'طلب مني {target} تذكيرك: {quote}', '{target} попросил напомнить вам: {quote}'],
  reminded_owner: ['Reminded {target} about "{subject}".', 'העברתי ל{target} תזכורת לגבי "{subject}".', '{target} wurde an „{subject}“ erinnert.', 'He recordado a {target} lo de «{subject}».', 'أرسلت إلى {target} تذكيراً بشأن «{subject}».', 'Напоминание о «{subject}» передано {target}.'],
  reminder_owner_failed: ['I couldn\'t reach {target} to send that reminder — you may want to ping them directly.', 'לא הצלחתי להעביר ל{target} את התזכורת — כדאי לפנות ישירות.', 'Ich konnte {target} für die Erinnerung nicht erreichen. Bitte wenden Sie sich direkt an diese Person.', 'No pude contactar con {target} para enviar el recordatorio. Conviene contactar directamente.', 'لم أتمكن من الوصول إلى {target} لإرسال التذكير. يُفضّل التواصل مباشرة.', 'Не удалось передать напоминание {target}. Лучше обратиться напрямую.'],
  reschedule_reask: ['{hi}, just circling back on "{subject}" — were you able to check on moving it to {time}? No rush, just want to lock it in when you can.', '{hi}, חוזרת לגבי "{subject}" — יצא לך לבדוק אם אפשר להעביר ל{time}? אין לחץ, רק רוצה לסגור כשיתאפשר.', '{hi}, ich frage noch einmal wegen „{subject}“: Konnten Sie die Verschiebung auf {time} prüfen? Keine Eile, ich möchte nur den Termin bestätigen, sobald es passt.', '{hi}, retomo «{subject}»: ¿pudiste comprobar si se puede cambiar a {time}? Sin prisa, solo quiero confirmarlo cuando puedas.', '{hi}، أعود بشأن «{subject}»: هل تمكنت من التحقق من نقله إلى {time}؟ لا استعجال، أود فقط تثبيت الموعد عندما يتيسر.', '{hi}, возвращаюсь к «{subject}»: удалось проверить перенос на {time}? Не тороплю, просто хочу согласовать, когда сможете.'],
  new_time: ['the new time', 'המועד החדש', 'die neue Zeit', 'la nueva hora', 'الموعد الجديد', 'новое время'],
  outreach_no_reply: ['{target} never replied to the message I sent — I\'ve closed that one out. Tell me if you want to try again.', '{target} לא השיבו להודעה ששלחתי — סגרתי את הבקשה. אפשר לבקש לנסות שוב.', '{target} hat auf meine Nachricht nicht geantwortet. Ich habe die Anfrage geschlossen. Sagen Sie Bescheid, wenn Sie es erneut versuchen möchten.', '{target} no respondió a mi mensaje. He cerrado la solicitud. Avísame si quieres intentarlo de nuevo.', 'لم يرد {target} على الرسالة التي أرسلتها، فأغلقت الطلب. أخبرني إذا أردت المحاولة مجدداً.', '{target} не ответил на отправленное сообщение. Запрос закрыт. Напишите, если хотите попробовать снова.'],
  outreach_no_decision: ['{target} replied but never came back with a real answer — I\'ve closed that one out. Tell me if you want to try again.', '{target} השיבו אך לא חזרו עם תשובה סופית — סגרתי את הבקשה. אפשר לבקש לנסות שוב.', '{target} hat geantwortet, aber keine Entscheidung mitgeteilt. Ich habe die Anfrage geschlossen. Sagen Sie Bescheid, wenn Sie es erneut versuchen möchten.', '{target} respondió, pero no dio una respuesta definitiva. He cerrado la solicitud. Avísame si quieres intentarlo de nuevo.', 'رد {target} لكنه لم يعد بإجابة نهائية، فأغلقت الطلب. أخبرني إذا أردت المحاولة مجدداً.', '{target} ответил, но окончательного решения не сообщил. Запрос закрыт. Напишите, если хотите попробовать снова.'],
  scheduled_failed: ['Couldn\'t send your scheduled message to {target} — it kept failing, so I\'ve given up. Nothing went out; let me know if you want to try again.', 'לא הצלחתי לשלוח את ההודעה המתוזמנת ל{target} לאחר כישלונות חוזרים, ולכן הפסקתי לנסות. דבר לא נשלח; אפשר לבקש לנסות שוב.', 'Die geplante Nachricht an {target} konnte wiederholt nicht gesendet werden. Ich habe die Versuche beendet. Es wurde nichts gesendet; sagen Sie Bescheid, wenn Sie es erneut versuchen möchten.', 'No pude enviar el mensaje programado a {target} tras varios fallos. He dejado de intentarlo. No se envió nada; avísame si quieres intentarlo de nuevo.', 'تعذّر إرسال رسالتك المجدولة إلى {target} بعد إخفاقات متكررة، فتوقفت عن المحاولة. لم يُرسل شيء؛ أخبرني إذا أردت المحاولة مجدداً.', 'Не удалось отправить запланированное сообщение адресату {target} после повторных ошибок. Попытки прекращены. Ничего не отправлено; напишите, если хотите попробовать снова.'],
  scheduled_unconfirmed: ['I attempted your scheduled message to {target}, but couldn\'t confirm the full outcome. I won\'t resend it automatically because that could duplicate the message. Please check the conversation before trying again.', 'ניסיתי לשלוח את ההודעה המתוזמנת ל{target}, אך לא הצלחתי לוודא את התוצאה המלאה. לא אשלח שוב אוטומטית כדי למנוע כפילות. בדקו את השיחה לפני ניסיון נוסף.', 'Ich habe versucht, die geplante Nachricht an {target} zu senden, konnte das Ergebnis aber nicht bestätigen. Um Duplikate zu vermeiden, sende ich sie nicht automatisch erneut. Bitte prüfen Sie vorher den Verlauf.', 'Intenté enviar el mensaje programado a {target}, pero no pude confirmar el resultado completo. No lo reenviaré automáticamente para evitar duplicados. Comprueba la conversación antes de intentarlo de nuevo.', 'حاولت إرسال رسالتك المجدولة إلى {target} لكن لم أتمكن من تأكيد النتيجة كاملة. لن أعيد الإرسال آلياً لتجنب التكرار. يرجى مراجعة المحادثة قبل المحاولة مجدداً.', 'Была попытка отправить запланированное сообщение адресату {target}, но результат не подтверждён. Автоматической повторной отправки не будет во избежание дублирования. Перед новой попыткой проверьте переписку.'],
  attachments_failed: ['Your scheduled message text was posted, but {count} attachment(s) failed. I haven\'t repeated the text.', 'טקסט ההודעה המתוזמנת נשלח, אך {count} קבצים מצורפים נכשלו. לא שלחתי את הטקסט שוב.', 'Der Text der geplanten Nachricht wurde gesendet, aber {count} Anhänge sind fehlgeschlagen. Ich habe den Text nicht erneut gesendet.', 'Se envió el texto del mensaje programado, pero fallaron {count} archivos adjuntos. No he repetido el texto.', 'تم إرسال نص الرسالة المجدولة، لكن تعذّر إرسال {count} من المرفقات. لم أكرر إرسال النص.', 'Текст запланированного сообщения отправлен, но {count} вложений не удалось доставить. Текст повторно не отправлялся.'],
  oof_declined: ['{target} said they no longer need time with you — I\'ve closed that one out.', '{target} אמרו שכבר אין צורך בפגישה איתך — סגרתי את הבקשה.', '{target} benötigt keinen Termin mehr mit Ihnen. Ich habe die Anfrage geschlossen.', '{target} dijo que ya no necesita reunirse contigo. He cerrado la solicitud.', 'قال {target} إنه لم يعد بحاجة إلى موعد معك، فأغلقت الطلب.', '{target} сообщил, что встреча с вами больше не нужна. Запрос закрыт.'],
  counter_limit: ['No agreement after two proposals on "{subject}". I\'ve closed the request{status}.', 'לא הושגה הסכמה אחרי שתי הצעות לגבי "{subject}". סגרתי את הבקשה{status}.', 'Keine Einigung nach zwei Vorschlägen zu „{subject}“. Ich habe die Anfrage geschlossen{status}.', 'No hubo acuerdo tras dos propuestas sobre «{subject}». He cerrado la solicitud{status}.', 'لم يحدث اتفاق بعد اقتراحين بشأن «{subject}». أغلقت الطلب{status}.', 'После двух предложений по «{subject}» договориться не удалось. Запрос закрыт{status}.'],
  requester_told: [' and asked the requester to contact you directly', ' וביקשתי מהפונה לפנות אליך ישירות', ' und die anfragende Person gebeten, Sie direkt zu kontaktieren', ' y he pedido a la persona que contacte contigo directamente', ' وطلبت من صاحب الطلب التواصل معك مباشرة', '; заявителю предложено связаться с вами напрямую'],
  requester_untold: ['; I could not confirm the requester was told', '; לא הצלחתי לוודא שהפונה עודכן', '; ich konnte nicht bestätigen, dass die anfragende Person informiert wurde', '; no pude confirmar que se haya informado a la persona', '؛ لم أتمكن من تأكيد إبلاغ صاحب الطلب', '; уведомление заявителя не подтверждено'],
  consequence_book: ['If yes → I\'ll book "{subject}"{time}.', 'אם כן ← אקבע את "{subject}"{time}.', 'Bei Zustimmung → ich buche „{subject}“{time}.', 'Si aceptas → reservaré «{subject}»{time}.', 'عند الموافقة ← سأحجز «{subject}»{time}.', 'Если да → назначу «{subject}»{time}.'],
  at_time: [' at {time}', ' ב{time}', ' um {time}', ' a las {time}', ' في {time}', ' на {time}'],
  consequence_move: ['If yes → I\'ll move "{subject}" to {time}.', 'אם כן ← אעביר את "{subject}" ל{time}.', 'Bei Zustimmung → ich verschiebe „{subject}“ auf {time}.', 'Si aceptas → cambiaré «{subject}» a {time}.', 'عند الموافقة ← سأنقل «{subject}» إلى {time}.', 'Если да → перенесу «{subject}» на {time}.'],
  consequence_pick: ['Reply with the time you pick → I\'ll move "{subject}" to it (or say no to leave it as is).', 'השיבו עם המועד שבחרתם ← אעביר אליו את "{subject}" (או השיבו לא כדי להשאיר ללא שינוי).', 'Nennen Sie die gewünschte Zeit → ich verschiebe „{subject}“ dorthin (oder sagen Sie nein, um nichts zu ändern).', 'Indica la hora que prefieres → cambiaré «{subject}» a esa hora (o di que no para dejarlo igual).', 'أجب بالوقت الذي تختاره ← سأنقل «{subject}» إليه (أو ارفض ليبقى كما هو).', 'Укажите выбранное время → перенесу «{subject}» на него (или откажитесь, чтобы оставить без изменений).'],
  consequence_cancel: ['If yes → I\'ll cancel "{subject}".', 'אם כן ← אבטל את "{subject}".', 'Bei Zustimmung → ich sage „{subject}“ ab.', 'Si aceptas → cancelaré «{subject}».', 'عند الموافقة ← سألغي «{subject}».', 'Если да → отменю «{subject}».'],
  consequence_update: ['If yes → I\'ll update "{subject}".', 'אם כן ← אעדכן את "{subject}".', 'Bei Zustimmung → ich aktualisiere „{subject}“.', 'Si aceptas → actualizaré «{subject}».', 'عند الموافقة ← سأحدّث «{subject}».', 'Если да → обновлю «{subject}».'],
  consequence_zone: ['If yes → I\'ll update their stored timezone to {value}.', 'אם כן ← אעדכן את אזור הזמן השמור ל{value}.', 'Bei Zustimmung → ich ändere die gespeicherte Zeitzone auf {value}.', 'Si aceptas → actualizaré la zona horaria guardada a {value}.', 'عند الموافقة ← سأحدّث المنطقة الزمنية المحفوظة إلى {value}.', 'Если да → обновлю сохранённый часовой пояс на {value}.'],
  consequence_run: ['If yes → I\'ll run {value}.', 'אם כן ← אבצע את {value}.', 'Bei Zustimmung → ich führe {value} aus.', 'Si aceptas → ejecutaré {value}.', 'عند الموافقة ← سأنفذ {value}.', 'Если да → выполню {value}.'],
  repeat_history: ['Repeated request after {count} prior refusal{plural}: {quote}. The requester confirmed they want you asked again.', 'בקשה חוזרת אחרי {count} סירובים קודמים: {quote}. הפונה אישר שרוצה לשאול אותך שוב.', 'Erneute Anfrage nach {count} vorherigen Ablehnungen: {quote}. Die anfragende Person hat bestätigt, dass erneut gefragt werden soll.', 'Solicitud repetida tras {count} rechazos anteriores: {quote}. La persona confirmó que quiere que te vuelva a preguntar.', 'طلب متكرر بعد {count} حالات رفض سابقة: {quote}. أكد صاحب الطلب رغبته في سؤالك مجدداً.', 'Повторный запрос после {count} предыдущих отказов: {quote}. Заявитель подтвердил желание обратиться к вам повторно.'],
  checked_reason: ['Checked when I raised this{time}: {quote}', 'נבדק כשהעליתי את הבקשה{time}: {quote}', 'Bei Erstellung der Anfrage geprüft{time}: {quote}', 'Comprobado al plantear la solicitud{time}: {quote}', 'تم التحقق عند طرح الطلب{time}: {quote}', 'Проверено при создании запроса{time}: {quote}'],
  clarification: ['Before this can run: {quote}', 'לפני הביצוע נדרש בירור: {quote}', 'Vor der Ausführung zu klären: {quote}', 'Antes de ejecutar, hay que aclarar: {quote}', 'قبل التنفيذ يجب توضيح: {quote}', 'Перед выполнением нужно уточнить: {quote}'],
  discussions: ['🗓️ Discussions — {time}', '🗓️ שיחות — {time}', '🗓️ Gespräche — {time}', '🗓️ Conversaciones — {time}', '🗓️ مناقشات — {time}', '🗓️ Обсуждения — {time}'],
  oof_expired: [
    "{hi}, {owner} is still away and it's been a while, so I've closed this one out rather than keep you waiting. Feel free to ask again any time.", '{hi}, {owner} עדיין לא נמצא וכבר עבר זמן, אז סגרתי את הבקשה כדי לא להשאיר אותך בהמתנה. אפשר לפנות שוב בכל עת.',
    '{hi}, {owner} ist weiterhin abwesend. Da schon einige Zeit vergangen ist, habe ich die Anfrage geschlossen. Sie können jederzeit erneut fragen.', '{hi}, {owner} sigue ausente. Como ya ha pasado bastante tiempo, he cerrado la solicitud para no dejarte esperando. Puedes volver a pedirlo cuando quieras.',
    '{hi}، ما زال {owner} غائباً وقد مضى وقت طويل، فأغلقت الطلب كي لا تبقى منتظراً. يمكنك السؤال مجدداً في أي وقت.', '{hi}, {owner} всё ещё отсутствует. Прошло уже много времени, поэтому запрос закрыт, чтобы не оставлять вас в ожидании. Можно обратиться снова в любое время.',
  ],
  oof_owner_expired: [
    "Stopped tracking {target}'s ask about {subject} — you've been away past the point I keep checking. Worth a manual ping if it still matters.", 'הפסקתי לעקוב אחרי הבקשה של {target} לגבי {subject} — ההיעדרות נמשכה מעבר לתקופת הבדיקה. כדאי לפנות ישירות אם זה עדיין רלוונטי.',
    'Die Anfrage von {target} zu {subject} wird nicht weiter verfolgt, da Ihre Abwesenheit den Prüfzeitraum überschritten hat. Bitte melden Sie sich bei Bedarf direkt.', 'He dejado de seguir la solicitud de {target} sobre {subject}: tu ausencia superó el plazo de comprobación. Conviene contactar directamente si sigue siendo importante.',
    'توقفت عن متابعة طلب {target} بخصوص {subject} لأن غيابك تجاوز فترة التحقق. يُفضّل التواصل مباشرة إذا ظل الأمر مهماً.', 'Отслеживание запроса от {target} по поводу {subject} прекращено: ваше отсутствие превысило срок проверок. Если вопрос ещё актуален, свяжитесь напрямую.',
  ],
  oof_unreachable: [
    "{hi}, sorry — I've been having trouble confirming when things freed up, so I've closed this one out. Feel free to ask again any time.", '{hi}, סליחה — לא הצלחתי לוודא מתי התפנה זמן, ולכן סגרתי את הבקשה. אפשר לפנות שוב בכל עת.',
    '{hi}, leider konnte ich nicht bestätigen, wann wieder Zeit frei ist. Ich habe die Anfrage geschlossen. Sie können jederzeit erneut fragen.', '{hi}, lo siento: no pude confirmar cuándo habría disponibilidad, así que he cerrado la solicitud. Puedes volver a pedirlo cuando quieras.',
    '{hi}، أعتذر، لم أتمكن من تأكيد موعد توفر الوقت، فأغلقت الطلب. يمكنك السؤال مجدداً في أي وقت.', '{hi}, извините, не удалось подтвердить, когда появится свободное время, поэтому запрос закрыт. Можно обратиться снова в любое время.',
  ],
  oof_owner_unreachable: [
    "Couldn't confirm your calendar to reach back out to {target} about {subject} — closed the tracking after repeated failures. Worth a manual ping if it still matters.", 'לא הצלחתי לבדוק את היומן כדי לחזור ל{target} לגבי {subject}. סגרתי את המעקב אחרי כישלונות חוזרים. כדאי לפנות ישירות אם זה עדיין רלוונטי.',
    'Ihr Kalender konnte nicht geprüft werden, um {target} wegen {subject} erneut zu kontaktieren. Die Nachverfolgung wurde nach wiederholten Fehlern beendet. Bitte melden Sie sich bei Bedarf direkt.', 'No pude comprobar tu calendario para volver a contactar con {target} sobre {subject}. Cerré el seguimiento tras varios fallos. Conviene contactar directamente si sigue siendo importante.',
    'تعذّر التحقق من تقويمك للتواصل مجدداً مع {target} بخصوص {subject}. أغلقت المتابعة بعد إخفاقات متكررة. يُفضّل التواصل مباشرة عند الحاجة.', 'Не удалось проверить календарь для повторного обращения к {target} по поводу {subject}. Отслеживание прекращено после повторных ошибок. При необходимости свяжитесь напрямую.',
  ],
  oof_return: [
    "{hi}, {owner} is back now — still want me to find a time for {subject}? Let me know and I'll get it set up.", '{hi}, {owner} חזר — עדיין תרצו שאמצא זמן ל{subject}? עדכנו אותי ואטפל בתיאום.',
    '{hi}, {owner} ist wieder da. Soll ich noch einen Termin für {subject} suchen? Geben Sie mir Bescheid, dann kümmere ich mich darum.', '{hi}, {owner} ya ha vuelto. ¿Quieres que busque un horario para {subject}? Avísame y lo organizo.',
    '{hi}، عاد {owner} الآن. هل ما زلت تريد أن أجد وقتاً لـ{subject}؟ أخبرني وسأتولى التنسيق.', '{hi}, {owner} уже вернулся. Ещё нужно подобрать время для {subject}? Сообщите, и я займусь согласованием.',
  ],
  oof_reask: [
    '{hi}, just circling back — still want to find time for {subject}? No rush, just want to close the loop.', '{hi}, חוזרת לבדוק — עדיין תרצו למצוא זמן ל{subject}? אין לחץ, רק רוצה לסגור את המעגל.',
    '{hi}, ich wollte noch einmal nachfragen: Möchten Sie noch einen Termin für {subject}? Keine Eile, ich möchte nur den Stand klären.', '{hi}, retomo el tema: ¿sigues queriendo buscar un horario para {subject}? Sin prisa, solo quiero cerrar el seguimiento.',
    '{hi}، أعود للسؤال: هل ما زلت تريد إيجاد وقت لـ{subject}؟ لا استعجال، فقط أود إغلاق المتابعة.', '{hi}, возвращаюсь к вопросу: ещё нужно подобрать время для {subject}? Не тороплю, просто хочу завершить согласование.',
  ],
  move_notice: [
    "{hi}, I moved our \"{subject}\" to {time}{reason}. If that doesn't work for you, just say the word and I'll sort it out with {owner}.", '{hi}, העברתי את "{subject}" ל{time}{reason}. אם זה לא מתאים, עדכנו אותי ואתאם עם {owner}.',
    '{hi}, ich habe „{subject}“ auf {time} verschoben{reason}. Falls das nicht passt, sagen Sie Bescheid; ich kläre es mit {owner}.', '{hi}, he cambiado «{subject}» a {time}{reason}. Si no te va bien, avísame y lo coordino con {owner}.',
    '{hi}، نقلت «{subject}» إلى {time}{reason}. إذا لم يناسبك، أخبرني وسأنسق مع {owner}.', '{hi}, встреча «{subject}» перенесена на {time}{reason}. Если это не подходит, сообщите, и я согласую с {owner}.',
  ],
  move_correction: [
    "{hi}, quick correction on \"{subject}\" — I told you {old}, and that's changed: it's now {time}. Sorry for the back-and-forth. If the new time doesn't work for you, say the word and I'll sort it out with {owner}.", '{hi}, תיקון לגבי "{subject}" — קודם אמרתי {old}, וזה השתנה: עכשיו {time}. סליחה על השינויים. אם המועד החדש לא מתאים, עדכנו אותי ואתאם עם {owner}.',
    '{hi}, eine Korrektur zu „{subject}“: Ich hatte {old} genannt, jetzt ist es {time}. Entschuldigung für die Änderungen. Falls der neue Termin nicht passt, sagen Sie Bescheid; ich kläre es mit {owner}.', '{hi}, una corrección sobre «{subject}»: te dije {old}, pero ahora es {time}. Disculpa los cambios. Si el nuevo horario no te va bien, avísame y lo coordino con {owner}.',
    '{hi}، تصحيح بشأن «{subject}»: أخبرتك سابقاً بـ{old}، لكنه تغير وأصبح {time}. أعتذر عن التغييرات. إذا لم يناسبك الموعد الجديد، أخبرني وسأنسق مع {owner}.', '{hi}, уточнение по «{subject}»: ранее было указано {old}, теперь время изменилось на {time}. Извините за изменения. Если новое время не подходит, сообщите, и я согласую с {owner}.',
  ],
  source_reason: [' — reason (original wording): {quote}', ' — סיבה (בניסוח המקורי): {quote}', ' — Grund (Originalwortlaut): {quote}', ' — motivo (texto original): {quote}', ' — السبب (بالصياغة الأصلية): {quote}', ' — причина (исходная формулировка): {quote}'],
  greeting: ['Hey {name}', 'היי {name}', 'Hallo {name}', 'Hola {name}', 'مرحباً {name}', 'Здравствуйте {name}'],
  subject: ['that ask', 'הבקשה הזאת', 'diese Anfrage', 'esa solicitud', 'هذا الطلب', 'этот запрос'],
  meeting: ['that meeting', 'הפגישה', 'dieser Termin', 'esa reunión', 'هذا الاجتماع', 'эта встреча'],
  owner_expired: [
    "I never heard back on the approval I asked about. I've closed it, let me know if you want to try again.", 'לא התקבלה תשובה לבקשת האישור. סגרתי אותה; אפשר לבקש לנסות שוב.',
    'Auf meine Genehmigungsanfrage kam keine Antwort. Ich habe sie geschlossen. Sagen Sie Bescheid, wenn Sie es erneut versuchen möchten.', 'No recibí respuesta a la solicitud de aprobación. La he cerrado; avísame si quieres intentarlo de nuevo.',
    'لم أتلق رداً على طلب الموافقة. أغلقته؛ أخبرني إذا أردت المحاولة مجدداً.', 'Ответ на запрос согласования не поступил. Запрос закрыт; напишите, если хотите попробовать снова.',
  ],
  owner_counter_expired: [
    "{target} never came back on what you suggested for \"{subject}\". I've closed it without agreement.", '{target} לא השיבו להצעה שלך לגבי "{subject}". סגרתי את הבקשה ללא הסכמה.',
    '{target} hat auf Ihren Vorschlag zu „{subject}“ nicht geantwortet. Ich habe die Anfrage ohne Einigung geschlossen.', '{target} no respondió a tu propuesta sobre «{subject}». He cerrado la solicitud sin acuerdo.',
    'لم يرد {target} على اقتراحك بشأن «{subject}». أغلقت الطلب دون اتفاق.', '{target} не ответил на ваше предложение по поводу «{subject}». Запрос закрыт без согласования.',
  ],
  failure: [
    "{hi} — I couldn't complete the request about {subject}. I've closed it; it needs a fresh check before trying again.",
    '{hi} — לא הצלחתי להשלים את הבקשה לגבי {subject}. סגרתי אותה; צריך לבדוק אותה מחדש לפני ניסיון נוסף.',
    '{hi} — ich konnte die Anfrage zu {subject} nicht abschließen. Ich habe sie geschlossen; vor einem neuen Versuch muss sie erneut geprüft werden.',
    '{hi} — no pude completar la solicitud sobre {subject}. La he cerrado; hay que revisarla antes de volver a intentarlo.',
    '{hi} — لم أتمكن من إكمال الطلب بخصوص {subject}. أغلقته؛ ويجب مراجعته قبل المحاولة مجدداً.',
    '{hi} — не удалось выполнить запрос по поводу {subject}. Запрос закрыт; перед новой попыткой нужна повторная проверка.',
  ],
  repeat_unconfirmed: [
    "{hi} — I didn't get confirmation to ask {owner} again about {subject}. I've closed this without raising it again.",
    '{hi} — לא התקבל אישור לפנות שוב ל{owner} לגבי {subject}. סגרתי את הבקשה ולא העליתי אותה שוב.',
    '{hi} — ich habe keine Bestätigung erhalten, {owner} erneut wegen {subject} zu fragen. Ich habe die Anfrage geschlossen, ohne erneut zu fragen.',
    '{hi} — no recibí confirmación para volver a preguntar a {owner} sobre {subject}. He cerrado la solicitud sin volver a plantearla.',
    '{hi} — لم أتلق تأكيداً لسؤال {owner} مجدداً عن {subject}. أغلقت الطلب دون طرحه مرة أخرى.',
    '{hi} — подтверждение на повторное обращение к {owner} по поводу {subject} не поступило. Запрос закрыт без повторного обращения.',
  ],
  colleague_unanswered: [
    "{hi} — I never heard back on what {owner} suggested for {subject}, so I've closed this without agreement. Please contact {owner} directly to continue.",
    '{hi} — לא קיבלתי תשובה על מה ש{owner} הציע לגבי {subject}, אז סגרתי את זה ללא הסכמה. כדי להמשיך, פנו ישירות ל{owner}.',
    '{hi} — auf den Vorschlag von {owner} zu {subject} kam keine Antwort. Die Anfrage ist ohne Einigung geschlossen. Bitte wenden Sie sich direkt an {owner}.',
    '{hi} — no recibí respuesta a lo que propuso {owner} sobre {subject}. He cerrado la solicitud sin acuerdo. Contacta directamente con {owner} para continuar.',
    '{hi} — لم أتلق رداً على اقتراح {owner} بخصوص {subject}، فأغلقت الطلب دون اتفاق. يرجى التواصل مباشرة مع {owner} للمتابعة.',
    '{hi} — ответ на предложение {owner} по поводу {subject} не поступил. Запрос закрыт без согласования. Для продолжения свяжитесь напрямую с {owner}.',
  ],
  owner_unanswered: [
    "{hi} — I couldn't get a read from {owner} on {subject}. Closing this for now; ping me when you want to try again.",
    '{hi} — לא הצלחתי לקבל תשובה מ{owner} לגבי {subject}. סוגרת את זה בינתיים — אפשר לנסות שוב מתי שתרצו.',
    '{hi} — ich habe von {owner} keine Antwort zu {subject} erhalten. Ich schließe die Anfrage vorerst; melden Sie sich, wenn Sie es erneut versuchen möchten.',
    '{hi} — no recibí respuesta de {owner} sobre {subject}. Cierro la solicitud por ahora; avísame si quieres intentarlo de nuevo.',
    '{hi} — لم أتلق رداً من {owner} بخصوص {subject}. سأغلق الطلب حالياً؛ أخبرني إذا أردت المحاولة مجدداً.',
    '{hi} — ответ от {owner} по поводу {subject} не поступил. Пока закрываю запрос; напишите, если захотите попробовать снова.',
  ],
  reminder_sent: [
    '{hi} — passed the reminder on to {target} about {subject}.', '{hi} — העברתי את התזכורת ל{target} לגבי {subject}.',
    '{hi} — die Erinnerung zu {subject} wurde an {target} übermittelt.', '{hi} — he enviado el recordatorio sobre {subject} a {target}.',
    '{hi} — أوصلت التذكير بخصوص {subject} إلى {target}.', '{hi} — напоминание о {subject} передано {target}.',
  ],
  reminder_failed: [
    "{hi} — couldn't reach {target} to pass the reminder along. Worth pinging them directly.", '{hi} — לא הצלחתי להשיג את {target} כדי להעביר את התזכורת. שווה לפנות אליו/אליה ישירות.',
    '{hi} — ich konnte {target} für die Erinnerung nicht erreichen. Bitte wenden Sie sich direkt an diese Person.', '{hi} — no pude contactar con {target} para pasarle el recordatorio. Conviene contactar directamente.',
    '{hi} — لم أتمكن من الوصول إلى {target} لإيصال التذكير. يُفضّل التواصل مباشرة.', '{hi} — не удалось связаться с {target} и передать напоминание. Лучше обратиться напрямую.',
  ],
  owner_reached: [
    "{hi} — this reached {owner}, he's/she's got it now.", '{hi} — זה הגיע ל{owner}, הוא/היא רואה את זה עכשיו.',
    '{hi} — die Nachricht ist bei {owner} angekommen.', '{hi} — el mensaje ha llegado a {owner}.', '{hi} — وصلت الرسالة إلى {owner}.', '{hi} — сообщение доставлено {owner}.',
  ],
  owner_unconfirmed: [
    "{hi} — I tried to get this to {owner} but couldn't confirm it landed. Worth checking with him directly.", '{hi} — ניסיתי להעביר את זה ל{owner} אבל לא הצלחתי לוודא שזה הגיע. שווה לוודא ישירות.',
    '{hi} — ich habe versucht, dies an {owner} zu übermitteln, konnte den Empfang aber nicht bestätigen. Bitte fragen Sie direkt nach.', '{hi} — intenté enviárselo a {owner}, pero no pude confirmar la entrega. Conviene comprobarlo directamente.',
    '{hi} — حاولت إيصال هذا إلى {owner} لكن لم أتمكن من تأكيد وصوله. يُفضّل التحقق مباشرة.', '{hi} — была попытка передать это {owner}, но доставка не подтверждена. Лучше уточнить напрямую.',
  ],
  backstop_failed: [
    "{hi} — I flagged your ask for {owner} as a backstop, but couldn't actually get it to him after several tries. Worth reaching him directly if it's still open.", '{hi} — סימנתי את הבקשה שלך ל{owner} כגיבוי, אבל לא הצלחתי להעביר לו אותה גם אחרי כמה ניסיונות. שווה לפנות אליו ישירות אם זה עדיין פתוח.',
    '{hi} — ich habe Ihre Anfrage vorsorglich für {owner} vorgemerkt, konnte sie aber nach mehreren Versuchen nicht zustellen. Falls sie noch offen ist, wenden Sie sich bitte direkt an {owner}.', '{hi} — marqué tu solicitud para {owner} como respaldo, pero no pude entregarla tras varios intentos. Si sigue pendiente, contacta directamente con {owner}.',
    '{hi} — علّمت طلبك لإيصاله إلى {owner} كإجراء احتياطي، لكن تعذّر إيصاله بعد عدة محاولات. تواصل مباشرة مع {owner} إذا كان الطلب ما زال قائماً.', '{hi} — запрос был отмечен для {owner} как резервное обращение, но несколько попыток доставки не удались. Если вопрос ещё актуален, свяжитесь напрямую с {owner}.',
  ],
  cancelled: [
    '{hi} — {owner} cancelled the request about {subject}.', '{hi} — {owner} ביטל את הבקשה לגבי {subject}.',
    '{hi} — {owner} hat die Anfrage zu {subject} storniert.', '{hi} — {owner} canceló la solicitud sobre {subject}.', '{hi} — ألغى {owner} الطلب بخصوص {subject}.', '{hi} — {owner} отменил запрос по поводу {subject}.',
  ],
  action_unconfirmed: [
    "{hi} — I tried to carry out the request about {subject}, but I couldn't confirm it worked. I have not repeated the action, and no further automatic check is pending.", '{hi} — נעשה ניסיון לבצע את הבקשה לגבי {subject}, אבל לא ניתן לאשר שהוא הצליח. הפעולה לא בוצעה שוב ואין בדיקה אוטומטית נוספת בהמתנה.',
    '{hi} — ich habe versucht, die Anfrage zu {subject} auszuführen, konnte den Erfolg aber nicht bestätigen. Die Aktion wurde nicht wiederholt; es steht keine weitere automatische Prüfung aus.', '{hi} — intenté realizar la solicitud sobre {subject}, pero no pude confirmar el resultado. No he repetido la acción y no hay otra comprobación automática pendiente.',
    '{hi} — حاولت تنفيذ الطلب بخصوص {subject}، لكن لم أتمكن من تأكيد نجاحه. لم أكرر الإجراء ولا يوجد تحقق آلي آخر قيد الانتظار.', '{hi} — была попытка выполнить запрос по поводу {subject}, но успех не подтверждён. Действие не повторялось, дальнейшая автоматическая проверка не запланирована.',
  ],
  booked: [
    '{hi}, locked in "{subject}" — calendar invite is on its way.', '{hi}, סגרנו על "{subject}" — הזימון בדרך.',
    '{hi}, „{subject}“ ist gebucht — die Kalendereinladung ist unterwegs.', '{hi}, «{subject}» está confirmado; la invitación está en camino.', '{hi}، تم تثبيت «{subject}» — دعوة التقويم في الطريق.', '{hi}, встреча «{subject}» назначена — приглашение отправляется.',
  ],
  meeting_cancelled: [
    '{hi}, {subject} has been cancelled — nothing further needed from you.', '{hi}, {subject} בוטלה — אין צורך בפעולה נוספת מצידך.',
    '{hi}, {subject} wurde abgesagt — Sie müssen nichts weiter tun.', '{hi}, {subject} se ha cancelado; no necesitas hacer nada más.', '{hi}، تم إلغاء {subject} — لا يلزمك أي إجراء آخر.', '{hi}, {subject} отменена — от вас больше ничего не требуется.',
  ],
  reschedule_cancelled: [
    "{hi}, update on {subject} — it's been cancelled, so no need to come back to me about the time. Sorry for the noise.", '{hi}, עדכון על {subject} — היא בוטלה, אז אין צורך לחזור אליי לגבי המועד. סליחה על הבלגן.',
    '{hi}, eine Aktualisierung zu {subject}: Der Termin wurde abgesagt. Sie müssen sich wegen der Uhrzeit nicht mehr melden. Entschuldigung für die Umstände.', '{hi}, una actualización sobre {subject}: se ha cancelado, así que ya no hace falta responder sobre la hora. Disculpa las molestias.',
    '{hi}، تحديث بشأن {subject}: تم إلغاؤها، فلا داعي للرد بشأن الموعد. أعتذر عن الإزعاج.', '{hi}, обновление по поводу {subject}: встреча отменена, поэтому отвечать о времени больше не нужно. Извините за беспокойство.',
  ],
  repeat_question: [
    "You're asking again after {owner} said no. Should I go to him with it again?", 'אתם מבקשים שוב אחרי ש{owner} אמר לא. האם לפנות אליו שוב עם הבקשה?',
    '{owner} hat die Anfrage bereits abgelehnt. Soll ich erneut nachfragen?', '{owner} ya rechazó la solicitud. ¿Quieres que vuelva a preguntarle?', 'سبق أن رفض {owner} الطلب. هل أطلب منه النظر فيه مجدداً؟', '{owner} уже отклонил запрос. Обратиться повторно?',
  ],
  proposals_expired: [
    "{hi} — we did not reach agreement about {subject} after two proposals, so I've closed the request. Please contact {owner} directly to work out the next step.", '{hi} — לא הגענו להסכמה לגבי {subject} אחרי שתי הצעות, אז סגרתי את הבקשה. כדאי לפנות ישירות ל{owner} להמשך התיאום.',
    '{hi} — nach zwei Vorschlägen gab es keine Einigung zu {subject}. Ich habe die Anfrage geschlossen. Bitte klären Sie das weitere Vorgehen direkt mit {owner}.', '{hi} — no llegamos a un acuerdo sobre {subject} tras dos propuestas, así que he cerrado la solicitud. Contacta directamente con {owner} para decidir el siguiente paso.',
    '{hi} — لم نتوصل إلى اتفاق بشأن {subject} بعد اقتراحين، فأغلقت الطلب. يرجى التواصل مباشرة مع {owner} لتحديد الخطوة التالية.', '{hi} — после двух предложений договориться о {subject} не удалось. Запрос закрыт. Для дальнейшего согласования свяжитесь напрямую с {owner}.',
  ],
  question: [
    '{hi} — {owner} asked (original wording): {quote}{tail}', '{hi} — {owner} שאל (בניסוח המקורי): {quote}{tail}',
    '{hi} — {owner} fragt (Originalwortlaut): {quote}{tail}', '{hi} — {owner} pregunta (texto original): {quote}{tail}', '{hi} — سأل {owner} (بالصياغة الأصلية): {quote}{tail}', '{hi} — вопрос от {owner} (исходная формулировка): {quote}{tail}',
  ],
  proposal: [
    '{hi} — {owner} suggested a different approach (original wording): {quote}. Does that work for you?', '{hi} — {owner} הציע משהו אחר (בניסוח המקורי): {quote}. זה עובד לך?',
    '{hi} — {owner} schlägt etwas anderes vor (Originalwortlaut): {quote}. Passt das für Sie?', '{hi} — {owner} propone otra opción (texto original): {quote}. ¿Te parece bien?', '{hi} — اقترح {owner} خياراً آخر (بالصياغة الأصلية): {quote}. هل يناسبك؟', '{hi} — {owner} предлагает другой вариант (исходная формулировка): {quote}. Вам подходит?',
  ],
  original: [
    "{owner}'s original wording: “{quote}”", 'הניסוח המקורי של {owner}: “{quote}”', 'Originalwortlaut von {owner}: „{quote}“', 'Texto original de {owner}: «{quote}»', 'الصياغة الأصلية لـ{owner}: «{quote}»', 'Исходная формулировка {owner}: «{quote}»',
  ],
  exhausted: [
    'I couldn\'t deliver the outcome of "{subject}" to {target} after three attempts. I\'ve stopped retrying their notification. Please contact them directly if needed.', 'לא הצלחתי להעביר ל{target} את התוצאה של "{subject}" אחרי שלושה ניסיונות. הפסקתי לנסות לשלוח את ההודעה. כדאי לפנות אליהם ישירות אם צריך.',
    'Das Ergebnis zu „{subject}“ konnte nach drei Versuchen nicht an {target} zugestellt werden. Es gibt keine weiteren Zustellversuche. Bitte nehmen Sie bei Bedarf direkt Kontakt auf.', 'No pude entregar el resultado de «{subject}» a {target} tras tres intentos. He dejado de reintentar la notificación. Contacta directamente si es necesario.',
    'لم أتمكن من إيصال نتيجة «{subject}» إلى {target} بعد ثلاث محاولات. توقفت عن إعادة إرسال الإشعار. يرجى التواصل مباشرة عند الحاجة.', 'Не удалось доставить результат по «{subject}» адресату {target} после трёх попыток. Повторные отправки прекращены. При необходимости свяжитесь напрямую.',
  ],
} as const;

export function relayNotice(lang: string, kind: keyof typeof relayCopy, values: Record<string, string> = {}): string {
  const index = ['en', 'he', 'de', 'es', 'ar', 'ru'].indexOf(lang);
  if (index < 0) throw new Error(`No deterministic relay copy for known language: ${lang}`);
  if (relayCopy[kind][index].includes('{hi}') && !values.hi) values = { ...values, hi: relayNotice(lang, 'greeting', { name: values.name ?? '' }).trim() };
  return relayCopy[kind][index].replace(/\{([a-z]+)\}/g, (_, key: string) => values[key] ?? '');
}

export interface RelayComposeParams {
  lang: string;
  /** Ready greeting — "Hey {first}" / "היי {first}" (name-less fallback handled). */
  hi: string;
  requesterFirst: string;
  ownerFirst: string;
  /** Leak-filtered subject (usableRelaySubject over caller candidates + row fields), or the fallback. */
  subject: string;
}

/**
 * The one deterministic closure relay to a requester. Returns true only when
 * the message confirmably landed (and requester_notified_at was stamped).
 * Never throws.
 */
export async function relayClosureToRequester(opts: {
  row: RequestRow;
  /** Needed only when the compose copy names the owner (ownerFirst is '' without it). */
  profile?: UserProfile;
  /** Log label, e.g. 'runExpiry requester loop-close'. */
  label: string;
  /** Extra subject candidates tried FIRST (each still leak-filtered). */
  subjectCandidates?: unknown[];
  /** Per-language generic fallback; default "that ask" / "הבקשה הזאת". */
  subjectFallback?: { en: string; he: string };
  compose?: (p: RelayComposeParams) => string;
  /** A transport retry reuses its previously authored body without recomposition. */
  body?: string;
}): Promise<boolean> {
  const { row, label } = opts;
  const requesterSlackId = row.requester_slack_id;
  // requester-relay-never-targets-owner — requester_slack_id can end up
  // self-referential (the owner's own id) when an upstream creation path
  // misreads his authority as 'colleague' (the same clamp class documented at
  // tasks/skill.ts's flagUnresolvedFreeformForOwner; confirmed in production
  // data as colleague_booking_record rows keyed on the owner himself).
  // Enforced once here rather than at each caller: closeMeetingArtifacts.ts
  // already filtered this before calling in; runExpiry/runFreeformFlagRetry
  // (runner.ts) hadn't.
  if (!requesterSlackId || requesterSlackId === row.owner_user_id) return false;
  // Once-only idempotency — the same field notifyRequesterOfDecision stamps and
  // reads. Fresh read: the row in hand may predate a stamp another path (the
  // resolver's relay, a prior cascade) just wrote.
  try {
    const fresh = getRequest(row.id);
    if (fresh && requesterRelayStopped(fresh)) return false;
    if (fresh?.requester_notified_at) {
      logger.info(`${label} — requester already notified, skipping`, { requestId: row.id });
      return false;
    }
  } catch { /* fall through — worst case is one extra DM attempt, still logged below */ }
  const conn = getConnection(row.owner_user_id, 'slack');
  const lang = requesterRelayLanguage(requesterSlackId);
  const requesterFirst = row.requester_name?.split(/\s+/)[0] ?? '';
  let body: string;
  try {
  if (opts.body !== undefined) body = opts.body;
  else {
  const hi = relayNotice(lang, 'greeting', { name: requesterFirst }).trim();
  const details = parseDetails<Record<string, unknown>>(row) ?? {};
  const fallback = opts.subjectFallback;
  const subject = [
    ...(opts.subjectCandidates ?? []),
    details.subject, details.question, row.subject,
  ].map(usableRelaySubject).find(Boolean) ?? (fallback && (lang === 'he' || lang === 'en') ? fallback[lang] : relayNotice(lang, 'subject'));
  body = opts.compose!({
    lang, hi, requesterFirst, subject,
    ownerFirst: opts.profile?.user.name.split(' ')[0] ?? '',
  });
  }
  } catch (err) {
    recordRequesterCompositionFailure(row);
    logger.warn(`${label} — deterministic copy unavailable in recipient language`, { requestId: row.id, lang, err: String(err).slice(0, 200) });
    return false;
  }
  if (!beginRequesterRelayAttempt(row, body)) return false;
  if (!conn) {
    recordRequesterRelayFailure(row, body, false);
    logger.warn(`${label} — no Slack connection; terminal delivery retained`, { requestId: row.id });
    return false;
  }
  // Requester's origin thread (MPIM channel or 1:1 DM) — same routing as
  // notifyRequesterOfDecision, so the close-loop never lands as a stray new
  // top-level DM with no history (v3.4.6).
  try {
    const res = row.origin_is_mpim && row.origin_channel
      ? await conn.postToChannel(row.origin_channel, body, { threadTs: row.origin_thread_ts ?? undefined })
      : await conn.sendDirect(requesterSlackId, body, { threadTs: row.origin_thread_ts ?? undefined });
    if (res.ok) {
      // Stamp ONLY on a confirmed send — a soft failure has bounded retries and
      // never reads downstream (tasks/skill.ts's requester_notified nudge) as
      // "they were told" when they weren't.
      completeRequesterRelay(row);
      logger.info(`${label} — sent`, { requestId: row.id, requesterSlackId, lang });
      return true;
    }
    logger.warn(`${label} — send failed, requester_notified_at left unset`, {
      requestId: row.id, requesterSlackId, reason: res.reason,
    });
    recordRequesterRelayFailure(row, body, isRequesterSendUnconfirmed(res));
  } catch (err) {
    logger.warn(`${label} — send threw, requester_notified_at left unset`, {
      requestId: row.id, err: String(err).slice(0, 200),
    });
    recordRequesterRelayFailure(row, body, true);
  }
  return false;
}

/** Slack's generic error includes post timeouts; its receipt is unknown. */
export function isRequesterSendUnconfirmed(result: { ok: boolean; reason?: string }): boolean {
  return result.ok !== true && result.reason === 'error';
}

/** Existing owner-notice receipt, independent of requester delivery and timers.
 * Owner-only terminal notices reuse this receipt without inventing a requester
 * outcome. A confirmed owner notice must not clear a failed requester relay. */
export function recordOwnerNotificationOutcome(row: RequestRow, result: { ok: boolean; reason?: string } | null): void {
  const delivery = result?.ok ? 'sent' : result && (isRequesterSendUnconfirmed(result) || result.reason === 'send_threw') ? 'unconfirmed' : 'failed';
  const current = getRequest(row.id) ?? row;
  const outcome = readOutcome(current);
  const previous = outcome.requester_relay as Record<string, unknown> | undefined;
  if (delivery === 'sent' && !previous) return;
  if (delivery === 'sent') {
    // A general owner notice is not the dedicated requester-exhaustion notice.
    // Clear its pending attention rather than setting the exhaustion helper's
    // sent marker and accidentally suppressing that later notification.
    const remaining = { ...previous };
    delete remaining.owner_delivery;
    delete remaining.owner_send_attempts;
    if (Object.keys(remaining).length) outcome.requester_relay = remaining;
    else delete outcome.requester_relay;
  } else outcome.requester_relay = { ...previous, owner_delivery: delivery };
  updateRequest(row.id, { outcomeJson: outcome });
}

/** Claim the transport opportunity synchronously, before any await or send. */
export function beginRequesterRelayAttempt(row: RequestRow, body: string): boolean {
  const current = getRequest(row.id) ?? row;
  if (current.requester_notified_at || requesterRelayStopped(current)) return false;
  if (!['resolved', 'cancelled', 'expired', 'logged'].includes(current.state)) return true;
  const outcome = readOutcome(current);
  const previous = outcome.requester_relay as { send_attempts?: number; delivery?: string } | undefined;
  const attempts = (previous?.send_attempts ?? (previous?.delivery ? 1 : 0)) + 1;
  if (attempts > 3) return false;
  // A crash or concurrent caller must see uncertainty, never a replayable send.
  updateRequest(row.id, { outcomeJson: { ...outcome, requester_relay: { ...previous, body, send_attempts: attempts, delivery: 'unconfirmed' } },
    nextCheckAt: null, nextCheckHandler: null });
  return true;
}

/** Exact terminal copy lives on its request; no second lifecycle or recomposition. */
export function recordRequesterRelayFailure(row: RequestRow, body: string, unconfirmed: boolean): void {
  const current = getRequest(row.id) ?? row;
  if (!['resolved', 'cancelled', 'expired', 'logged'].includes(current.state) || current.requester_notified_at) return;
  const outcome = readOutcome(current);
  const previous = outcome.requester_relay as { send_attempts?: number; delivery?: string } | undefined;
  if (previous?.delivery !== 'unconfirmed') return;
  // Settle only the opportunity already claimed before this transport call.
  const attempts = previous.send_attempts ?? 1;
  const exhausted = !unconfirmed && attempts >= 3;
  updateRequest(row.id, {
    outcomeJson: { ...outcome, requester_relay: { ...previous, body, send_attempts: attempts,
      delivery: unconfirmed ? 'unconfirmed' : exhausted ? 'exhausted' : 'failed' } },
    // Exhaustion retains the existing timer only to deliver the owner notice.
    nextCheckAt: unconfirmed ? null : new Date(Date.now() + 5 * 60000).toISOString(),
    nextCheckHandler: unconfirmed ? null : 'requester_relay_retry',
  });
}

export function requesterRelayStopped(row: RequestRow): boolean {
  const current = getRequest(row.id) ?? row;
  const delivery = (readOutcome(current).requester_relay as { delivery?: string } | undefined)?.delivery;
  return delivery === 'unconfirmed' || delivery === 'exhausted';
}

/** The exhausted relay retains its existing timer for bounded owner delivery. */
async function notifyOwnerOfExhaustedRelay(row: RequestRow, profile: UserProfile): Promise<void> {
  const current = getRequest(row.id) ?? row;
  const outcome = readOutcome(current);
  const stored = outcome.requester_relay as { body: string; delivery: string; owner_delivery?: string; owner_send_attempts?: number };
  if (stored.owner_delivery === 'sent' || stored.owner_delivery === 'unconfirmed' || (stored.owner_send_attempts ?? 0) >= 3) {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return;
  }
  const attempts = (stored.owner_send_attempts ?? 0) + 1;
  const persist = (delivery: string): void => {
    const retry = delivery === 'failed' && attempts < 3;
    updateRequest(row.id, { outcomeJson: { ...outcome, requester_relay: { ...stored, owner_delivery: delivery, owner_send_attempts: attempts } },
      nextCheckAt: retry ? new Date(Date.now() + 5 * 60000).toISOString() : null,
      nextCheckHandler: retry ? 'requester_relay_retry' : null,
    });
  };
  const conn = getConnection(row.owner_user_id, 'slack');
  if (!conn) { persist('failed'); return; }
  let body: string;
  try {
    body = relayNotice(requesterRelayLanguage(row.owner_user_id), 'exhausted', { target: row.requester_name ?? row.requester_slack_id ?? '', subject: row.subject });
  } catch {
    // Rendering failed before transport: retain failed visibility, not a false
    // unknown-send receipt or a timer that can only repeat the same failure.
    updateRequest(row.id, { outcomeJson: { ...outcome, requester_relay: { ...stored, owner_delivery: 'failed', owner_send_attempts: stored.owner_send_attempts ?? 0 } },
      nextCheckAt: null, nextCheckHandler: null });
    return;
  }
  // Claim before the daily-thread lookup's first await as well as transport.
  persist('unconfirmed');
  try {
    const { getOrCreateOwnerDailyThread } = await import('../../utils/ownerDailyThread');
    const daily = await getOrCreateOwnerDailyThread({ profile, conn });
    // Persist uncertainty before transport: a restart cannot duplicate this notice.
    const result = daily
      ? await conn.postToChannel(daily.channel, body, { threadTs: daily.rootTs })
      : await conn.sendDirect(row.owner_user_id, body);
    persist(result.ok ? 'sent' : isRequesterSendUnconfirmed(result) ? 'unconfirmed' : 'failed');
  } catch (err) {
    persist('unconfirmed');
    logger.warn('requester relay exhaustion owner notice unconfirmed', { requestId: row.id, err: String(err).slice(0, 200) });
  }
}

function readOutcome(row: RequestRow): Record<string, unknown> {
  try { return JSON.parse(row.outcome_json ?? '{}') as Record<string, unknown>; } catch { return {}; }
}

/** No send occurred. Keep the existing owner-brief failure path, without a retry body. */
export function recordRequesterCompositionFailure(row: RequestRow): void {
  const current = getRequest(row.id) ?? row;
  if (current.requester_notified_at || requesterRelayStopped(current)) return;
  const outcome = readOutcome(current);
  const previous = outcome.requester_relay as { send_attempts?: number; delivery?: string } | undefined;
  updateRequest(row.id, {
    outcomeJson: { ...outcome, requester_relay: { ...previous, delivery: 'failed', send_attempts: previous?.send_attempts ?? 0 } },
    ...(['resolved', 'cancelled', 'expired', 'logged'].includes(current.state) ? { nextCheckAt: null, nextCheckHandler: null } : {}),
  });
}

export function completeRequesterRelay(row: RequestRow): void {
  const current = getRequest(row.id) ?? row;
  const outcome = readOutcome(current);
  const hadRetry = !!outcome.requester_relay;
  const previous = outcome.requester_relay as { owner_delivery?: string; owner_send_attempts?: number } | undefined;
  if (previous?.owner_delivery && previous.owner_delivery !== 'sent') {
    outcome.requester_relay = { owner_delivery: previous.owner_delivery,
      ...(previous.owner_send_attempts !== undefined ? { owner_send_attempts: previous.owner_send_attempts } : {}) };
  } else delete outcome.requester_relay;
  updateRequest(row.id, {
    requesterNotifiedAt: new Date().toISOString(),
    ...(hadRetry ? { outcomeJson: outcome, nextCheckAt: null, nextCheckHandler: null } : {}),
  });
}

/** Called under the same request lock as decisions and closure writers. */
export async function retryRequesterRelay(row: RequestRow, profile: UserProfile): Promise<boolean> {
  row = getRequest(row.id) ?? row;
  const stored = readOutcome(row).requester_relay as { body?: unknown; delivery?: unknown } | undefined;
  if (stored?.delivery === 'exhausted') {
    await notifyOwnerOfExhaustedRelay(row, profile);
    return false;
  }
  if (row.requester_notified_at || stored?.delivery !== 'failed' || typeof stored.body !== 'string') {
    updateRequest(row.id, { nextCheckAt: null, nextCheckHandler: null });
    return false;
  }
  const body = stored.body;
  const sent = await relayClosureToRequester({ row, profile, label: 'terminal requester delivery retry', body });
  if (!sent) {
    const fresh = getRequest(row.id) ?? row;
    if ((readOutcome(fresh).requester_relay as { delivery?: string } | undefined)?.delivery === 'exhausted') await notifyOwnerOfExhaustedRelay(fresh, profile);
    return false;
  }
  // Match the ordinary resolver relay's history grounding after recovery.
  try {
    const { appendToConversation } = await import('../../db/conversations');
    if (row.origin_thread_ts) appendToConversation(row.origin_thread_ts, row.origin_channel ?? '', { role: 'assistant', content: body });
    if (!row.origin_is_mpim && row.requester_slack_id) {
      const { createOutreachJob } = await import('../../db/jobs');
      createOutreachJob({ owner_user_id: row.owner_user_id, owner_channel: row.origin_channel ?? '',
        owner_thread_ts: row.origin_thread_ts ?? undefined, colleague_slack_id: row.requester_slack_id,
        colleague_name: row.requester_name ?? row.requester_slack_id, message: body, await_reply: 0,
        sent_at: new Date().toISOString(), skipRequestBridge: true });
    }
  } catch (err) {
    logger.warn('terminal requester retry history failed after confirmed delivery', { requestId: row.id, err: String(err).slice(0, 200) });
  }
  return true;
}
