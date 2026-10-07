/**
 * Arabic for every sentence the server can send a portal client (2 Oct 2026).
 *
 * KEYED BY THE EXACT ENGLISH, byte for byte — the English stays canonical in
 * the code that writes it, and `localizeMessage` turns it into Arabic on the way
 * out. A message built from a template literal is a PATTERN: each `${…}` is
 * written `{1}`, `{2}`… numbered in order of appearance in the ENGLISH, and the
 * Arabic uses the same numbers wherever they read naturally. A captured value is
 * looked up again, so a field label or a nested sentence becomes Arabic too.
 *
 * `test/server-messages-coverage.spec.ts` scans the source for every thrown
 * message and fails when one has no entry here — a new English sentence needs
 * its Arabic in the same change.
 *
 * Register: Modern Standard Arabic, polite, concise, Western digits; brand
 * names, codes and identifiers stay Latin (glossary: the portal's GLOSSARY.md).
 * Class-validator's defaults name a camelCase PROPERTY; the Arabic deliberately
 * drops it ("القيمة") — the `fields` map already puts the sentence under its
 * input, and an identifier inside an Arabic sentence reads as noise.
 */
export const SERVER_MESSAGES_AR: Readonly<Record<string, string>> = {
  // ── Labels and values captured inside sentences ──────────────────────────────
  'First name': 'الاسم الأول',
  'Last name': 'اسم العائلة',
  'Date of birth': 'تاريخ الميلاد',
  Nationality: 'الجنسية',
  'Phone number': 'رقم الهاتف',
  'Country of residence': 'بلد الإقامة',
  Address: 'العنوان',
  City: 'المدينة',
  'State / Province': 'الولاية / المحافظة',
  'Postal code': 'الرمز البريدي',
  'First Name': 'الاسم الأول',
  'Last Name': 'اسم العائلة',
  'Date of Birth': 'تاريخ الميلاد',
  'Phone Number': 'رقم الهاتف',
  'Country of Residence': 'بلد الإقامة',
  'Residential Address': 'عنوان السكن',
  'Postal / ZIP code': 'الرمز البريدي',
  Selfie: 'صورة سيلفي',
  'Selfie Photo': 'صورة سيلفي',
  'Identity document': 'وثيقة الهوية',
  'Proof of address': 'إثبات العنوان',
  'minimum deposit': 'الحد الأدنى للإيداع',
  'maximum deposit': 'الحد الأقصى للإيداع',
  'minimum withdrawal': 'الحد الأدنى للسحب',
  'maximum withdrawal': 'الحد الأقصى للسحب',
  live: 'حقيقي',
  demo: 'تجريبي',
  active: 'نشط',
  suspended: 'موقوف',
  closed: 'مغلق',
  pending: 'قيد الانتظار',
  approved: 'مقبول',
  rejected: 'مرفوض',
  submitted: 'مُرسَل',
  under_review: 'قيد المراجعة',
  cancelled: 'ملغى',
  completed: 'مكتمل',
  failed: 'فشل',
  processing: 'قيد المعالجة',

  // ── The exception filter's own answers ───────────────────────────────────────
  'Too many attempts. Please wait a moment and try again.':
    'محاولات كثيرة جداً. يُرجى الانتظار قليلاً ثم المحاولة مرة أخرى.',
  'Too many attempts. Please try again in {1} seconds.':
    'محاولات كثيرة جداً. يُرجى المحاولة مرة أخرى بعد {1} ثانية.',
  'Too many attempts. Please try again in {1} minute.':
    'محاولات كثيرة جداً. يُرجى المحاولة مرة أخرى بعد {1} دقيقة.',
  'Too many attempts. Please try again in {1} minutes.':
    'محاولات كثيرة جداً. يُرجى المحاولة مرة أخرى بعد {1} دقيقة.',
  'That request body is too large.': 'حجم الطلب كبير جداً.',
  'That record already exists.': 'هذا السجل موجود مسبقاً.',
  'A referenced record does not exist.': 'أحد السجلات المشار إليها غير موجود.',
  'A value in the request is not a valid identifier.': 'إحدى القيم في الطلب ليست معرّفاً صالحاً.',
  'An unexpected error occurred. Quote the request id when reporting this.':
    'حدث خطأ غير متوقع. يُرجى ذكر رقم الطلب عند الإبلاغ عنه.',
  'The service is briefly unavailable. Please try again in a moment.':
    'الخدمة غير متاحة مؤقتاً. يُرجى المحاولة مرة أخرى بعد لحظات.',

  // ── Framework defaults (Nest, multer, the built-in pipes) ────────────────────
  Unauthorized: 'يلزم تسجيل الدخول',
  'Forbidden resource': 'ليست لديك صلاحية للوصول إلى هذا المورد',
  Forbidden: 'غير مسموح',
  'Not Found': 'غير موجود',
  'Bad Request': 'طلب غير صالح',
  Conflict: 'تعارض مع بيانات موجودة',
  'Internal server error': 'حدث خطأ في الخادم',
  'Internal Server Error': 'حدث خطأ في الخادم',
  'Payload Too Large': 'حجم الطلب كبير جداً',
  'Too Many Requests': 'طلبات كثيرة جداً',
  'ThrottlerException: Too Many Requests': 'طلبات كثيرة جداً',
  'Service Unavailable': 'الخدمة غير متاحة حالياً',
  'Cannot GET {1}': 'هذا المسار غير موجود: {1}',
  'Cannot POST {1}': 'هذا المسار غير موجود: {1}',
  'Cannot PUT {1}': 'هذا المسار غير موجود: {1}',
  'Cannot PATCH {1}': 'هذا المسار غير موجود: {1}',
  'Cannot DELETE {1}': 'هذا المسار غير موجود: {1}',
  'File too large': 'الملف كبير جداً',
  'File is required': 'الملف مطلوب',
  'Too many files': 'عدد الملفات كبير جداً',
  'Too many parts': 'عدد أجزاء الطلب كبير جداً',
  'Too many fields': 'عدد الحقول كبير جداً',
  'Unexpected field': 'حقل غير متوقع',
  'Field name too long': 'اسم الحقل طويل جداً',
  'Field value too long': 'قيمة الحقل طويلة جداً',
  'Field name missing': 'اسم الحقل مفقود',
  'Multipart: Boundary not found': 'تعذّرت قراءة الملف المرفوع',
  'Malformed part header': 'تعذّرت قراءة الملف المرفوع',
  'Unexpected end of form': 'انقطع رفع الملف قبل اكتماله',
  'Unexpected end of file': 'انقطع رفع الملف قبل اكتماله',
  'Validation failed (uuid is expected)': 'المعرّف غير صالح',
  'Validation failed (uuid v{1} is expected)': 'المعرّف غير صالح',
  'Validation failed (numeric string is expected)': 'يجب أن تكون القيمة رقماً',
  'Validation failed (enum string is expected)': 'القيمة غير صالحة',
  'Validation failed (boolean string is expected)': 'القيمة غير صالحة',
  'Validation failed (expected size is less than {1})':
    'حجم الملف أكبر من المسموح (الحد الأقصى {1} بايت)',
  'Validation failed (current file size is {1}, expected size is less than {2})':
    'حجم الملف أكبر من المسموح (الحد الأقصى {2} بايت)',

  // ── class-validator defaults (the property name is dropped, see header) ─────
  '{1} must be a string': 'يجب أن تكون القيمة نصاً',
  'each value in {1} must be a string': 'يجب أن تكون كل قيمة نصاً',
  '{1} should not be empty': 'هذا الحقل مطلوب',
  'each value in {1} should not be empty': 'لا يمكن ترك أي قيمة فارغة',
  '{1} should not be null or undefined': 'هذا الحقل مطلوب',
  '{1} must be an email': 'أدخل عنوان بريد إلكتروني صالحاً',
  '{1} must be one of the following values: {2}': 'يجب أن تكون القيمة إحدى القيم التالية: {2}',
  'each value in {1} must be one of the following values: {2}':
    'يجب أن تكون كل قيمة إحدى القيم التالية: {2}',
  '{1} must be a number string': 'يجب أن تكون القيمة رقماً',
  '{1} must be shorter than or equal to {2} characters': 'يجب ألا يزيد عدد الأحرف عن {2}',
  'each value in {1} must be shorter than or equal to {2} characters':
    'يجب ألا يزيد عدد أحرف كل قيمة عن {2}',
  '{1} must be longer than or equal to {2} characters': 'يجب ألا يقل عدد الأحرف عن {2}',
  '{1} must not be less than {2}': 'يجب ألا تقل القيمة عن {2}',
  '{1} must not be greater than {2}': 'يجب ألا تزيد القيمة عن {2}',
  '{1} must match {2} regular expression': 'صيغة القيمة غير صحيحة',
  'each value in {1} must match {2} regular expression': 'صيغة إحدى القيم غير صحيحة',
  '{1} must be an integer number': 'يجب أن تكون القيمة عدداً صحيحاً',
  '{1} must be a boolean value': 'يجب أن تكون القيمة نعم أو لا',
  '{1} must be an array': 'يجب أن تكون القيمة قائمة',
  '{1} must be a UUID': 'يجب أن تكون القيمة معرّفاً صالحاً',
  'each value in {1} must be a UUID': 'يجب أن تكون كل قيمة معرّفاً صالحاً',
  '{1} must contain no more than {2} elements': 'يجب ألا يزيد عدد العناصر عن {2}',
  '{1} must contain at least {2} elements': 'يجب ألا يقل عدد العناصر عن {2}',
  '{1} must be a valid ISO 8601 date string': 'يجب أن تكون القيمة تاريخاً صالحاً',
  '{1} must be a Date instance': 'يجب أن تكون القيمة تاريخاً صالحاً',
  '{1} must be an object': 'صيغة القيمة غير صالحة',
  'nested property {1} must be either object or array': 'صيغة القيمة غير صالحة',
  '{1} must be a URL address': 'يجب أن تكون القيمة رابطاً صالحاً',
  '{1} must be a number conforming to the specified constraints': 'يجب أن تكون القيمة رقماً صالحاً',
  '{1} must be a hexadecimal color': 'يجب أن تكون القيمة لوناً بصيغة سداسية عشرية',
  'property {1} should not exist': 'هذا الحقل غير مسموح به',
  'an unknown value was passed to the validate function': 'تعذّر التحقق من الطلب',

  // ── common/ ──────────────────────────────────────────────────────────────────
  "{1} must be a client's Portal ID": 'يجب أن تكون القيمة رقم عميل صالحاً في البوابة',
  "must be a client's Portal ID": 'يجب أن تكون القيمة رقم عميل صالحاً في البوابة',
  'The minimum must be above zero.': 'يجب أن يكون الحد الأدنى أكبر من صفر.',
  "It can only narrow the currency's deposit range, {1}–{2} {3}.":
    'يمكنه فقط تضييق نطاق الإيداع للعملة، {1}–{2} {3}.',
  'The maximum must be above zero.': 'يجب أن يكون الحد الأقصى أكبر من صفر.',
  'The maximum cannot be below the minimum.': 'لا يمكن أن يكون الحد الأقصى أقل من الحد الأدنى.',
  'The {1} must be above zero.': 'يجب أن يكون {1} أكبر من صفر.',
  'The {1} cannot be below the {2} ({3}).': 'لا يمكن أن يكون {1} أقل من {2} ({3}).',
  'No mail server is configured. An administrator must set one up in Settings → Email.':
    'لم يُضبط خادم بريد بعد. يجب على أحد المسؤولين إعداده من الإعدادات ← البريد الإلكتروني.',
  'format must be one of: {1}. "{2}" is not supported — this API writes CSV only, and serving CSV bytes under another extension would be a file the spreadsheet refuses to open.':
    'يجب أن تكون الصيغة إحدى القيم: {1}. الصيغة "{2}" غير مدعومة — يصدّر النظام ملفات CSV فقط.',
  'must be one of: {1}': 'يجب أن تكون القيمة إحدى القيم: {1}',
  'This cursor was created for a list sorted by "{1}", but this request sorts by "{2}". Start from the first page when you change the sort.':
    'أُنشئ مؤشر الصفحات هذا لقائمة مرتبة حسب "{1}"، بينما يرتّب هذا الطلب حسب "{2}". ابدأ من الصفحة الأولى عند تغيير الترتيب.',
  'Cannot paginate by a non-scalar sort value (received {1}). Sortable columns must be text, numeric, boolean or a timestamp.':
    'لا يمكن التقسيم إلى صفحات حسب قيمة ترتيب غير بسيطة ({1}). يجب أن تكون أعمدة الترتيب نصاً أو رقماً أو قيمة منطقية أو طابعاً زمنياً.',
  'This method is not available in your country.': 'هذه الطريقة غير متاحة في بلدك.',
  'Choose Allow only or Deny only for these countries.':
    'اختر «السماح فقط» أو «المنع فقط» لهذه البلدان.',
  'Choose at least one country for this rule.': 'اختر بلداً واحداً على الأقل لهذه القاعدة.',
  '{1} is not a country we know.': '{1} ليس بلداً معروفاً لدينا.',
  'A method can ask for at most {1} details.': 'يمكن للطريقة أن تطلب {1} من التفاصيل كحد أقصى.',
  'This detail has an invalid id. Remove it and add it again.':
    'معرّف هذا البند غير صالح. احذفه ثم أضفه من جديد.',
  'Two details share one id. Remove one and add it again.':
    'يشترك بندان في المعرّف نفسه. احذف أحدهما ثم أضفه من جديد.',
  'Name each detail in 1 to {1} characters.': 'سمِّ كل بند بما بين 1 و{1} حرفاً.',
  'Two details are called “{1}”. Give each its own name.':
    'يوجد بندان باسم «{1}». أعطِ كل بند اسماً مختلفاً.',
  'A detail is either text (any code) or a phone number.':
    'يكون البند إما نصاً (أي رمز) أو رقم هاتف.',
  'Keep the hint under {1} characters.': 'يجب ألا يتجاوز عدد أحرف التلميح {1}.',
  'Keep the Arabic name under {1} characters.': 'يجب ألا يتجاوز عدد أحرف الاسم العربي {1}.',
  'Keep the Arabic hint under {1} characters.': 'يجب ألا يتجاوز عدد أحرف التلميح العربي {1}.',
  'The details could not be read.': 'تعذّرت قراءة التفاصيل.',
  'Enter a valid phone number.': 'أدخل رقم هاتف صالحاً.',
  '{1} must be at most {2} characters, on one line.':
    'يجب ألا يتجاوز عدد أحرف {1} {2}، وفي سطر واحد.',
  "{1} is being checked against the client's documents right now. It can change once the reviewer decides.":
    'تجري الآن مطابقة {1} مع وثائق العميل. يمكن تغييره بعد أن يتخذ المراجع قراره.',
  '{1} was verified by KYC. Only an admin who may correct verified details can change it.':
    'تم التحقق من {1} ضمن التحقق من الهوية. لا يمكن تغييره إلا لمسؤول مخوّل بتصحيح البيانات الموثّقة.',
  'Choose the country code, then enter the number after it.':
    'اختر رمز الدولة، ثم أدخل الرقم بعده.',
  'Enter the phone number after +{1}.': 'أدخل رقم الهاتف بعد ‎+{1}.',
  'This phone number is too short. Enter all the digits after +{1}.':
    'رقم الهاتف هذا قصير جداً. أدخل جميع الأرقام بعد ‎+{1}.',
  'This phone number is too short. Enter all the digits after the country code.':
    'رقم الهاتف هذا قصير جداً. أدخل جميع الأرقام بعد رمز الدولة.',
  'This phone number is too long. Check the digits after +{1}.':
    'رقم الهاتف هذا طويل جداً. تحقّق من الأرقام بعد ‎+{1}.',
  'This phone number is too long. Check the digits after the country code.':
    'رقم الهاتف هذا طويل جداً. تحقّق من الأرقام بعد رمز الدولة.',
  'That country code does not exist. Choose the country from the list.':
    'رمز الدولة هذا غير موجود. اختر الدولة من القائمة.',
  'This is not a valid phone number. Check the digits after +{1}.':
    'رقم الهاتف غير صالح. تحقّق من الأرقام بعد ‎+{1}.',
  'This is not a valid phone number. Check the digits after the country code.':
    'رقم الهاتف غير صالح. تحقّق من الأرقام بعد رمز الدولة.',
  '{1} contains characters we cannot store.': 'يحتوي حقل {1} على أحرف لا يمكننا حفظها.',
  '{1} must be at most {2} characters.': 'يجب ألا يتجاوز عدد أحرف {1} {2}.',
  '{1} may contain only letters, spaces, hyphens and apostrophes — exactly as on your ID.':
    'يجب أن يحتوي {1} على أحرف ومسافات وشرطات وفواصل عليا فقط — تماماً كما في وثيقة هويتك.',
  'Enter your date of birth as a real date (YYYY-MM-DD).':
    'أدخل تاريخ ميلادك كتاريخ صحيح (YYYY-MM-DD).',
  'Date of birth cannot be in the future.': 'لا يمكن أن يكون تاريخ الميلاد في المستقبل.',
  'You must be at least {1} years old to open an account.':
    'يجب أن يكون عمرك {1} عاماً على الأقل لفتح حساب.',
  'Check the year of your date of birth.': 'تحقّق من سنة ميلادك.',
  'Choose your country of residence from the list.': 'اختر بلد إقامتك من القائمة.',
  'Choose your nationality from the list.': 'اختر جنسيتك من القائمة.',
  'Enter your street address — building, street and area.':
    'أدخل عنوانك — المبنى والشارع والمنطقة.',
  'Address must be at most {1} characters.': 'يجب ألا يتجاوز عدد أحرف العنوان {1}.',
  'Enter the name of your city or town.': 'أدخل اسم مدينتك أو بلدتك.',
  'Enter your state, province or region.': 'أدخل ولايتك أو محافظتك أو منطقتك.',
  'Enter a postal code using letters, numbers, spaces or hyphens (for example 1103 or SW1A 1AA).':
    'أدخل رمزاً بريدياً يتكون من أحرف وأرقام ومسافات أو شرطات (مثل 1103 أو SW1A 1AA).',
  '{1} is not one of the countries we accept. Choose one from the list.':
    '{1} ليس من البلدان التي نقبلها. اختر بلداً من القائمة.',
  '{1} is not one of the nationalities we accept. Choose one from the list.':
    '{1} ليست من الجنسيات التي نقبلها. اختر جنسية من القائمة.',
  '{1} must be one of: {2}': 'يجب أن تكون القيمة إحدى القيم: {2}',
  '{1} must be a date formatted YYYY-MM-DD': 'يجب أن تكون القيمة تاريخاً بصيغة YYYY-MM-DD',
  'must be a date formatted YYYY-MM-DD': 'يجب أن تكون القيمة تاريخاً بصيغة YYYY-MM-DD',
  '{1} must be at most {2} characters': 'يجب ألا يزيد عدد الأحرف عن {2}',
  'must be at most {1} characters': 'يجب ألا يزيد عدد الأحرف عن {1}',
  'must be a UUID': 'يجب أن تكون القيمة معرّفاً صالحاً',
  'must be a step id': 'يجب أن تكون القيمة معرّف خطوة صالحاً',
  '{1} cannot {2}: the {3} permission is required.': 'لا يمكن لـ {1} تنفيذ {2}: يلزم إذن {3}.',
  '{1} cannot {2}: one of {3} is required.': 'لا يمكن لـ {1} تنفيذ {2}: يلزم أحد الأذونات {3}.',
  'Request rejected: failed anti-forgery validation.':
    'رُفض الطلب: لم يجتز التحقق من الحماية ضد التزوير. أعد تحميل الصفحة ثم حاول مرة أخرى.',
  'This idempotency-key was already used for a different request. Use a new key for a new operation, and reuse a key only to retry the identical one.':
    'استُخدم مفتاح منع التكرار هذا لطلب مختلف. استخدم مفتاحاً جديداً لكل عملية جديدة.',
  'An identical request is still being processed. Retry in a moment; it will not run twice.':
    'لا يزال طلب مماثل قيد المعالجة. أعد المحاولة بعد لحظات؛ لن يُنفَّذ مرتين.',
  'This endpoint requires an idempotency-key header: a unique value per intended operation, reused only when retrying that same operation.':
    'يتطلب هذا الطلب ترويسة idempotency-key بقيمة فريدة لكل عملية.',
  'Too many failed sign-in attempts. Please try again in {1} second.':
    'محاولات تسجيل دخول فاشلة كثيرة. يُرجى المحاولة مرة أخرى بعد {1} ثانية.',
  'Too many failed sign-in attempts. Please try again in {1} seconds.':
    'محاولات تسجيل دخول فاشلة كثيرة. يُرجى المحاولة مرة أخرى بعد {1} ثانية.',
  'Too many failed sign-in attempts. Please try again in {1} minute.':
    'محاولات تسجيل دخول فاشلة كثيرة. يُرجى المحاولة مرة أخرى بعد {1} دقيقة.',
  'Too many failed sign-in attempts. Please try again in {1} minutes.':
    'محاولات تسجيل دخول فاشلة كثيرة. يُرجى المحاولة مرة أخرى بعد {1} دقيقة.',
  '{1} is not a valid host.': '{1} ليس اسم مضيف صالحاً.',
  '{1} may not point at this server itself ({2}).':
    'لا يجوز أن يشير {1} إلى هذا الخادم نفسه ({2}).',
  '{1} may not point at a private or internal address ({2}). It has to be a host on the public internet.':
    'لا يجوز أن يشير {1} إلى عنوان خاص أو داخلي ({2}). يجب أن يكون مضيفاً على الإنترنت العام.',
  '{1} resolves to a private or internal address ({2} → {3}). It has to be a host on the public internet.':
    'يشير {1} إلى عنوان خاص أو داخلي ({2} → {3}). يجب أن يكون مضيفاً على الإنترنت العام.',
  'Replay protection is unavailable: no Redis connection is configured. Refusing the request rather than accepting one that cannot be checked.':
    'الحماية من إعادة الإرسال غير متاحة لعدم ضبط اتصال Redis، لذا رُفض الطلب.',
  'Replay protection is unavailable. Refusing the request rather than accepting one that cannot be checked.':
    'الحماية من إعادة الإرسال غير متاحة، لذا رُفض الطلب.',
  'This request has already been delivered. A signed payload may be used exactly once.':
    'تم تسليم هذا الطلب مسبقاً. لا يمكن استخدام الحمولة الموقّعة إلا مرة واحدة.',
  'The stored SMTP password could not be decrypted. Either APP_ENCRYPTION_KEY has changed since it was saved, or the stored value was modified. Re-enter the password to store it again under the current key.':
    'تعذّر فك تشفير كلمة مرور SMTP المحفوظة. أعد إدخال كلمة المرور لحفظها بالمفتاح الحالي.',
  'APP_ENCRYPTION_KEY is not set, so this secret cannot be stored. It is the key that encrypts the SMTP password at rest; generate one with `openssl rand -base64 48` and add it to the environment. There is no default on purpose — a built-in key would be published in this repository and shared by every deployment that forgot to set one.':
    'لم يُضبط APP_ENCRYPTION_KEY، لذا لا يمكن حفظ هذه القيمة السرية.',
  'Stored secret is not in the expected v1 format and cannot be read.':
    'القيمة السرية المحفوظة ليست بالصيغة المتوقعة ولا يمكن قراءتها.',
  'Cannot sort {1} by "{2}": that field is hidden from your role.':
    'لا يمكن ترتيب {1} حسب "{2}": هذا الحقل مخفي عن دورك.',
  'Cannot sort {1} by "{2}". Allowed: {3}.':
    'الترتيب حسب "{2}" غير متاح في {1}. القيم المسموح بها: {3}.',
  'Cannot order by "{1}". Allowed: asc, desc.':
    'لا يمكن الترتيب حسب "{1}". القيم المسموح بها: asc، desc.',
  'That PDF contains embedded scripts or attachments, so it cannot be accepted as an identity document. Please upload a plain scan or a photo of the document instead.':
    'يحتوي ملف PDF هذا على نصوص برمجية أو مرفقات مضمّنة، لذا لا يمكن قبوله كوثيقة هوية. يُرجى تحميل نسخة ممسوحة عادية أو صورة للوثيقة بدلاً منه.',
  'Only JPEG, PNG and WebP images are accepted.': 'لا تُقبل إلا صور JPEG وPNG وWebP.',
  'Only JPG, PNG, WEBP images and PDF files are allowed. If you are on an iPhone, set Settings → Camera → Formats to "Most Compatible" and retake the photo, or choose it from Photos so it is converted to JPG.':
    'لا يُسمح إلا بصور JPG وPNG وWEBP وملفات PDF. إذا كنت تستخدم iPhone، فاضبط الإعدادات ← الكاميرا ← التنسيقات على "الأكثر توافقاً" ثم أعد التقاط الصورة، أو اخترها من تطبيق الصور ليتم تحويلها إلى JPG.',
  'Only JPG, PNG, WEBP images and PDF files are accepted as a receipt. If you are on an iPhone, set Settings → Camera → Formats to "Most Compatible" and retake the photo, or choose it from Photos so it is converted to JPG.':
    'لا تُقبل كإيصال إلا صور JPG وPNG وWEBP وملفات PDF. إذا كنت تستخدم iPhone، فاضبط الإعدادات ← الكاميرا ← التنسيقات على "الأكثر توافقاً" ثم أعد التقاط الصورة، أو اخترها من تطبيق الصور ليتم تحويلها إلى JPG.',
  'Only JPEG, PNG, WebP and SVG images are accepted.': 'لا تُقبل إلا صور JPEG وPNG وWebP وSVG.',
  'That file is empty.': 'هذا الملف فارغ.',
  'That file is larger than the {1}MB limit.': 'حجم هذا الملف يتجاوز الحد المسموح وهو {1} MB.',
  'The file content does not match its declared type. {1}':
    'محتوى الملف لا يطابق نوعه المُعلن. {1}',
  'This account has used {1}MB of its {2}MB document allowance, and this file would take it over. Remove a document you no longer need, or contact support.':
    'استخدم هذا الحساب {1} MB من أصل {2} MB المخصصة للوثائق، وهذا الملف سيتجاوز الحد. احذف وثيقة لم تعد بحاجة إليها، أو تواصل مع الدعم.',
  'STORAGE_DRIVER=disk — uploads go to the local filesystem and are NOT durable: not backed up, not replicated, lost with this host. Correct for development and the test suite; never for anything holding real client documents.':
    'STORAGE_DRIVER=disk — تُحفظ الملفات على القرص المحلي وليست دائمة.',
  'Cannot filter by country: that field is hidden from your role.':
    'لا يمكن التصفية حسب البلد: هذا الحقل مخفي عن دورك.',
  'Notification not found.': 'الإشعار غير موجود.',

  // ── compliance (KYC, uploads) ────────────────────────────────────────────────
  'docType must be a catalogue value like national_id':
    'نوع الوثيقة غير صالح. اختر وثيقة من القائمة.',
  '{1} is too long ({2} characters at most).': '{1} طويل جداً (الحد الأقصى لعدد الأحرف {2}).',
  '{1}: "{2}" is not one of its choices.': '{1}: "{2}" ليس من الخيارات المتاحة.',
  '{1} is incomplete. Enter the full number after the country code.':
    '{1} غير مكتمل. أدخل الرقم كاملاً بعد رمز الدولة.',
  '{1} is not a valid date.': '{1}: التاريخ غير صالح.',
  '{1} must be yes or no.': '{1}: يجب أن تكون الإجابة نعم أو لا.',
  '{1} is required.': 'حقل {1} مطلوب.',
  'KYC submission not found.': 'طلب التحقق من الهوية غير موجود.',
  'Only a submitted KYC can be approved; this one is {1}.':
    'لا يمكن قبول إلا طلب تحقق مُرسَل؛ حالة هذا الطلب: {1}.',
  'This KYC submission is already approved.': 'تمت الموافقة على طلب التحقق هذا مسبقاً.',
  'This submission cannot be approved as it stands: {1}. Return it to the client to complete.':
    'لا يمكن قبول هذا الطلب بوضعه الحالي: {1}. أعده إلى العميل لاستكماله.',
  'This submission was changed by another reviewer. Reload it and try again.':
    'عدّل مراجع آخر هذا الطلب. أعد تحميله ثم حاول مرة أخرى.',
  'Only a submission that is under review can be handed back.':
    'لا يمكن إرجاع إلا طلب قيد المراجعة.',
  'This submission is already waiting in the queue.': 'هذا الطلب ينتظر في قائمة الانتظار مسبقاً.',
  'This submission was decided or released first.': 'تم البتّ في هذا الطلب أو إرجاعه مسبقاً.',
  'Only submitted KYC can be claimed for review.':
    'لا يمكن استلام إلا طلبات التحقق المُرسَلة للمراجعة.',
  'This submission is already being reviewed.': 'هذا الطلب قيد المراجعة مسبقاً.',
  'Another reviewer claimed this submission first.': 'استلم مراجع آخر هذا الطلب أولاً.',
  'KYC already approved.': 'تم التحقق من هويتك مسبقاً.',
  'This correction applies to an APPROVED submission; this one is {1}. In every other state the client can edit their own details.':
    'ينطبق هذا التصحيح على طلب مقبول فقط؛ حالة هذا الطلب: {1}. في أي حالة أخرى يمكن للعميل تعديل بياناته بنفسه.',
  'KYC is under review. You cannot edit it now.':
    'طلب التحقق من الهوية قيد المراجعة. لا يمكنك تعديله الآن.',
  'A correction does not change the phone number — edit it on the client’s profile.':
    'لا يغيّر التصحيح رقم الهاتف — عدّله من الملف الشخصي للعميل.',
  'Only an approved verification can be returned for re-verification. A submission still under review is returned with a rejection.':
    'لا يمكن طلب إعادة التحقق إلا لتحقق مقبول. أما الطلب الذي لا يزال قيد المراجعة فيُعاد برفضه.',
  'This verification changed while you were deciding. Reload it and try again.':
    'تغيّر هذا التحقق أثناء اتخاذك القرار. أعد تحميله ثم حاول مرة أخرى.',
  'This submission changed while it was being approved: {1}. Reload it and try again.':
    'تغيّر هذا الطلب أثناء اعتماده: {1}. أعد تحميله ثم حاول مرة أخرى.',
  'KYC is under review. You cannot change your documents now.':
    'طلب التحقق من الهوية قيد المراجعة. لا يمكنك تغيير وثائقك الآن.',
  'Another reviewer is holding this submission. It must be handed back first.':
    'يتولى مراجع آخر هذا الطلب. يجب إرجاعه أولاً.',
  '{1} is reviewing this submission. Ask them to hand it back first.':
    'يراجع {1} هذا الطلب. اطلب منه إرجاعه أولاً.',
  'This submission was claimed or decided by another reviewer while you were deciding. Reload it and try again.':
    'استلم مراجع آخر هذا الطلب أو بتّ فيه أثناء اتخاذك القرار. أعد تحميله ثم حاول مرة أخرى.',
  'Only a submitted KYC can be rejected; this one is {1}.':
    'لا يمكن رفض إلا طلب تحقق مُرسَل؛ حالة هذا الطلب: {1}.',
  'KYC data reset successfully.': 'تمت إعادة تعيين بيانات التحقق من الهوية بنجاح.',
  'An approved verification cannot be reset. If your details have changed, contact support: they can correct them on your verification, or ask you to verify again.':
    'لا يمكن إعادة تعيين تحقق مقبول. إذا تغيّرت بياناتك، فتواصل مع الدعم: يمكنهم تصحيحها في طلب التحقق أو أن يطلبوا منك التحقق من جديد.',
  'Your submission is being reviewed and cannot be reset right now.':
    'طلبك قيد المراجعة ولا يمكن إعادة تعيينه الآن.',
  'ID document front is required.': 'الوجه الأمامي لوثيقة الهوية مطلوب.',
  'Proof of address is required.': 'إثبات العنوان مطلوب.',
  'Selfie is required.': 'صورة السيلفي مطلوبة.',
  '{1} is incomplete: {2}.': 'خطوة {1} غير مكتملة: {2}.',
  'The client cannot be asked for: {1}.': 'لا يمكن أن يُطلب من العميل: {1}.',
  'Not something this client can update: {1}. Choose from the details, the pages on file and the questions on their form.':
    'لا يمكن لهذا العميل تحديث: {1}. اختر من البيانات أو الصفحات المحفوظة أو أسئلة نموذجه.',
  'The {1} step does not collect answers.': 'خطوة {1} لا تجمع إجابات.',
  'Unknown step: {1}': 'خطوة غير معروفة: {1}',
  '{1} is not part of this verification.': '{1} ليس جزءاً من هذا التحقق.',
  'Unknown file field: {1}': 'حقل ملف غير معروف: {1}',
  '{1} is not a document this step accepts.': '{1} ليست وثيقة تقبلها هذه الخطوة.',
  '{1} is not a document this verification accepts.': '{1} ليست وثيقة يقبلها هذا التحقق.',
  'File uploaded.': 'تم تحميل الملف.',
  'Please replace the documents the reviewer returned: {1}.':
    'يُرجى استبدال الوثائق التي أعادها المراجع: {1}.',
  'KYC has already been submitted and is awaiting review.':
    'تم إرسال طلب التحقق من الهوية مسبقاً وهو بانتظار المراجعة.',
  'That file is larger than the {1}MB limit. Most phone cameras can be set to a smaller size, or you can retake the photo — a clear photo of the document is usually well under the limit.':
    'حجم هذا الملف يتجاوز الحد المسموح وهو {1} MB. يمكن ضبط معظم كاميرات الهواتف على حجم أصغر، أو يمكنك إعادة التقاط الصورة — الصورة الواضحة للوثيقة تكون عادةً أقل بكثير من الحد.',
  'Photo not found.': 'الصورة غير موجودة.',
  'Logo not found.': 'الشعار غير موجود.',
  'Receipt not found.': 'الإيصال غير موجود.',
  'Document not found.': 'الوثيقة غير موجودة.',
  'Document access cannot be recorded right now, so it cannot be served. Please retry.':
    'تعذّر تسجيل الوصول إلى الوثيقة حالياً، لذا لا يمكن عرضها. يُرجى إعادة المحاولة.',
  'Invalid or expired admin token.': 'رمز المسؤول غير صالح أو منتهي الصلاحية.',
  'Your network is not permitted to reach the administration API.':
    'شبكتك غير مسموح لها بالوصول إلى واجهة الإدارة.',
  'Please verify your email address before accessing your documents.':
    'يُرجى تأكيد بريدك الإلكتروني قبل الوصول إلى وثائقك.',
  'Authentication required to access documents.': 'يلزم تسجيل الدخول للوصول إلى الوثائق.',
  'This administrator account has been suspended.': 'تم إيقاف حساب المسؤول هذا.',
  'The kyc.documents.view or kyc.review permission is required to view documents.':
    'يلزم إذن kyc.documents.view أو kyc.review لعرض الوثائق.',
  'You can only access your own documents.': 'يمكنك الوصول إلى وثائقك فقط.',
  'The deposits.proofs.view or deposits.approve permission is required to view receipts.':
    'يلزم إذن deposits.proofs.view أو deposits.approve لعرض الإيصالات.',
  'You can only access your own receipts.': 'يمكنك الوصول إلى إيصالاتك فقط.',

  // ── currencies, links, platforms, leverages ─────────────────────────────────
  '{1} is not currently available on this platform.': '{1} غير متاحة حالياً على هذه المنصة.',
  'Currency {1} already exists.': 'العملة {1} موجودة مسبقاً.',
  '{1} is the default currency and cannot be disabled. Make another currency the default first.':
    '{1} هي العملة الافتراضية ولا يمكن تعطيلها. اجعل عملة أخرى افتراضية أولاً.',
  'A platform must have a default currency. Set another currency as the default instead — that moves the flag.':
    'يجب أن تكون للمنصة عملة افتراضية. اجعل عملة أخرى افتراضية بدلاً من ذلك.',
  'The default currency cannot be deleted. Make another currency the default first.':
    'لا يمكن حذف العملة الافتراضية. اجعل عملة أخرى افتراضية أولاً.',
  '{1} cannot be deleted: {2} wallet(s) in it hold money. Disable it instead.':
    'لا يمكن حذف {1}: توجد {2} محفظة بهذه العملة تحتوي على أموال. عطّلها بدلاً من ذلك.',
  '{1} cannot be deleted: its wallets have a history of money movements. Disable it instead.':
    'لا يمكن حذف {1}: لمحافظها سجل حركات مالية. عطّلها بدلاً من ذلك.',
  '{1} cannot be deleted: payment methods, trading accounts or records still use it. Disable it instead.':
    'لا يمكن حذف {1}: لا تزال طرق دفع أو حسابات تداول أو سجلات تستخدمها. عطّلها بدلاً من ذلك.',
  'minDeposit must be an amount, e.g. 10 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأدنى للإيداع مبلغاً، مثل 10 أو 5000000 (حتى 8 منازل عشرية)',
  'maxDeposit must be an amount, e.g. 10 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأقصى للإيداع مبلغاً، مثل 10 أو 5000000 (حتى 8 منازل عشرية)',
  'minWithdrawal must be an amount, e.g. 10 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأدنى للسحب مبلغاً، مثل 10 أو 5000000 (حتى 8 منازل عشرية)',
  'maxWithdrawal must be an amount, e.g. 10 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأقصى للسحب مبلغاً، مثل 10 أو 5000000 (حتى 8 منازل عشرية)',
  'code must be upper-case letters and digits only, e.g. EUR or USDT':
    'يجب أن يتكون الرمز من أحرف لاتينية كبيرة وأرقام فقط، مثل EUR أو USDT',
  'No such link.': 'الرابط غير موجود.',
  'That is not a complete URL. Include the scheme, for example https://example.com/calendar':
    'هذا ليس رابطاً كاملاً. أضف البادئة، مثل https://example.com/calendar',
  "A link must be http or https. '{1}' is not allowed — this URL becomes a link in every client's browser.":
    "يجب أن يبدأ الرابط بـ http أو https. البادئة '{1}' غير مسموح بها — فهذا الرابط يظهر في متصفح كل عميل.",
  'A link needs a title — it is what the client reads.':
    'يحتاج الرابط إلى عنوان — فهو ما يقرؤه العميل.',
  'That is not a complete URL. Include the scheme, for example https://downloads.example.com/app.dmg':
    'هذا ليس رابطاً كاملاً. أضف البادئة، مثل https://downloads.example.com/app.dmg',
  "Download links must use https. '{1}' is not allowed — clients install what they fetch from here.":
    "يجب أن تستخدم روابط التنزيل https. البادئة '{1}' غير مسموح بها — فالعملاء يثبّتون ما ينزّلونه من هنا.",
  "Unknown platform '{1}'. Expected one of: {2}.": "منصة غير معروفة '{1}'. القيم المتوقعة: {2}.",
  '{1}:1 is already on the ladder.': 'الرافعة المالية {1}:1 موجودة في القائمة مسبقاً.',
  'No leverage {1}:1.': 'لا توجد رافعة مالية {1}:1.',
  'This is the only leverage on offer. Enable another before disabling this one — an empty ladder leaves clients an account-opening form with no options.':
    'هذه هي الرافعة المالية الوحيدة المعروضة. فعّل رافعة أخرى قبل تعطيل هذه.',
  'Accounts are open at {1}:1, so it cannot be deleted. Disable it instead — that takes it off the menu and leaves those accounts trading.':
    'توجد حسابات مفتوحة برافعة {1}:1، لذا لا يمكن حذفها. عطّلها بدلاً من ذلك — فيتوقف عرضها وتستمر تلك الحسابات في التداول.',
  'A leverage is a positive whole number — 500 means 500:1.':
    'الرافعة المالية عدد صحيح موجب — 500 تعني 500:1.',
  '{1}:1 is not a leverage this platform offers.':
    'الرافعة المالية {1}:1 غير متاحة على هذه المنصة.',
  '{1}:1 is not currently available on this platform.':
    'الرافعة المالية {1}:1 غير متاحة حالياً على هذه المنصة.',
  "subjectId must be a client's Portal ID or a record's uuid":
    'يجب أن تكون القيمة رقم عميل في البوابة أو معرّف سجل',

  // ── IB / partners ────────────────────────────────────────────────────────────
  'Accrual not found.': 'العمولة المستحقة غير موجودة.',
  'commissionPerLot must be a non-negative decimal with at most eight places, as a string — e.g. "10" or "7.50000000"':
    'يجب أن تكون العمولة لكل لوت رقماً عشرياً غير سالب بثماني منازل عشرية كحد أقصى، مثل "10" أو "7.50000000"',
  'rebatePerLot must be a non-negative decimal with at most eight places, as a string — e.g. "10" or "7.50000000"':
    'يجب أن تكون العمولة المستردة لكل لوت رقماً عشرياً غير سالب بثماني منازل عشرية كحد أقصى، مثل "10" أو "7.50000000"',
  'commissionShare must be a percentage between 0 and 100 with at most four places, as a string — e.g. "70" or "33.3333"':
    'يجب أن تكون حصة العمولة نسبة مئوية بين 0 و100 بأربع منازل عشرية كحد أقصى، مثل "70" أو "33.3333"',
  'rebateShare must be a percentage between 0 and 100 with at most four places, as a string — e.g. "70" or "33.3333"':
    'يجب أن تكون حصة العمولة المستردة نسبة مئوية بين 0 و100 بأربع منازل عشرية كحد أقصى، مثل "70" أو "33.3333"',
  'Only a pending application can be rejected; this one is {1}.':
    'لا يمكن رفض إلا طلب قيد الانتظار؛ حالة هذا الطلب: {1}.',
  'That partner does not exist.': 'هذا الشريك غير موجود.',
  // Partner structure from the console (7 Oct 2026).
  'A partner is a main partner (level 1) or a sub-partner (level 2); there is no other level.':
    'الشريك إما شريك رئيسي (المستوى 1) أو شريك فرعي (المستوى 2)؛ لا يوجد مستوى آخر.',
  'A sub-partner (level 2) sits under a main partner. Choose the main partner to place them under.':
    'الشريك الفرعي (المستوى 2) يكون تحت شريك رئيسي. اختر الشريك الرئيسي الذي سيُوضع تحته.',
  'A partner cannot be placed under themselves.': 'لا يمكن وضع الشريك تحت نفسه.',
  'This client is already a partner.': 'هذا العميل شريك بالفعل.',
  'That client does not exist.': 'هذا العميل غير موجود.',
  'Level {1} is not configured, and a partner on an unconfigured level earns nothing. Add it on the Commission Levels page first.':
    'المستوى {1} غير مُعدّ، والشريك على مستوى غير مُعدّ لا يكسب شيئاً. أضفه من صفحة مستويات العمولة أولاً.',
  'Level {1} ("{2}") is disabled, and a disabled level pays nothing. Enable it first, or choose another.':
    'المستوى {1} ("{2}") معطّل، والمستوى المعطّل لا يدفع شيئاً. فعّله أولاً أو اختر مستوى آخر.',
  'That partner already sits beneath this one, so the change would create a loop in the payout chain.':
    'هذا الشريك يقع تحت هذا الشريك مسبقاً، لذا سيُنشئ التغيير حلقة في سلسلة الدفع.',
  'The chosen parent partner does not exist.': 'الشريك الأعلى المختار غير موجود.',
  'The chosen parent partner is suspended.': 'الشريك الأعلى المختار موقوف.',
  'Could not allocate a referral code. Please try again.':
    'تعذّر تخصيص رمز إحالة. يُرجى المحاولة مرة أخرى.',
  'A rejection needs a reason. Choose one, or write a note.':
    'يتطلب الرفض سبباً. اختر سبباً أو اكتب ملاحظة.',
  'Your identity must be verified before you can apply to the partner programme.':
    'يجب التحقق من هويتك قبل أن تتمكن من التقدم إلى برنامج الشركاء.',
  'You are already a partner.': 'أنت شريك بالفعل.',
  'Account not found.': 'الحساب غير موجود.',
  'Please verify your email address before you apply to the partner programme.':
    'يُرجى تأكيد بريدك الإلكتروني قبل التقدم إلى برنامج الشركاء.',
  'You already have an application awaiting review.': 'لديك طلب بانتظار المراجعة بالفعل.',
  'Choose the partner programme you are applying for. An application cannot be submitted without one.':
    'اختر برنامج الشركاء الذي تتقدم إليه. لا يمكن إرسال الطلب دون ذلك.',
  'That partner programme is not open for applications. Choose one from the list.':
    'برنامج الشركاء هذا لا يستقبل طلبات. اختر برنامجاً من القائمة.',
  'Application not found.': 'الطلب غير موجود.',
  'Only a pending application can be approved; this one is {1}.':
    'لا يمكن قبول إلا طلب قيد الانتظار؛ حالة هذا الطلب: {1}.',
  'This applicant’s introducer, a partner outside your territory, cannot take a new sub-partner. Choose a parent in your territory, or place them at the top.':
    'الشريك الذي عرّف مقدّم الطلب خارج نطاقك ولا يمكنه أخذ شريك فرعي جديد. اختر شريكاً أعلى ضمن نطاقك، أو ضعه في أعلى السلسلة.',
  'Choose the agency to appoint this partner under. A partner cannot be approved without one — their clients would be offered the entire product catalogue.':
    'اختر الوكالة التي سيُعيَّن هذا الشريك تحتها. لا يمكن قبول شريك دون وكالة.',
  'That agency does not exist. Reload and try again.':
    'هذه الوكالة غير موجودة. أعد التحميل ثم حاول مرة أخرى.',
  'The chosen parent stands on level {1}, and the ladder has no enabled level {2} beneath them. Add or enable that level on the Commission Levels page, or approve this application under a different parent.':
    'الشريك الأعلى المختار على المستوى {1}، ولا يوجد مستوى {2} مفعّل تحته. أضف ذلك المستوى أو فعّله من صفحة مستويات العمولة، أو اقبل الطلب تحت شريك أعلى آخر.',
  'This application was changed by another reviewer. Reload and try again.':
    'عدّل مراجع آخر هذا الطلب. أعد التحميل ثم حاول مرة أخرى.',
  'The partner who introduced you is already on the deepest level of the partner programme, so a new partner account cannot be opened beneath them.':
    'الشريك الذي عرّفك موجود بالفعل على أعمق مستوى في برنامج الشركاء، لذا لا يمكن فتح حساب شريك جديد تحته.',
  "A commission type named '{1}' already exists. Edit that one, or choose a different name.":
    "يوجد نوع عمولة باسم '{1}' مسبقاً. عدّله أو اختر اسماً مختلفاً.",
  'Commission type not found.': 'نوع العمولة غير موجود.',
  "{1} are sold on '{2}', and a disabled type stops paying on every product using it. Move those products to another type first.":
    "تُباع {1} على '{2}'، والنوع المعطّل يتوقف عن الدفع على كل منتج يستخدمه. انقل تلك المنتجات إلى نوع آخر أولاً.",
  "{1} is sold on '{2}', and a disabled type stops paying on every product using it. Move those products to another type first.":
    "يُباع {1} على '{2}'، والنوع المعطّل يتوقف عن الدفع على كل منتج يستخدمه. انقل تلك المنتجات إلى نوع آخر أولاً.",
  "A commission type named '{1}' already exists.": "يوجد نوع عمولة باسم '{1}' مسبقاً.",
  "{1} are sold on '{2}'. Move those products to another type before deleting it, or disable it instead.":
    "تُباع {1} على '{2}'. انقل تلك المنتجات إلى نوع آخر قبل حذفه، أو عطّله بدلاً من ذلك.",
  "{1} is sold on '{2}'. Move those products to another type before deleting it, or disable it instead.":
    "يُباع {1} على '{2}'. انقل تلك المنتجات إلى نوع آخر قبل حذفه، أو عطّله بدلاً من ذلك.",
  "'{1}' has priced {2}, and the record of what was paid has to stay explicable. Disable it instead of deleting it.":
    "سُعِّر بـ '{1}' ما يلي: {2}، ويجب أن يبقى سجل المدفوعات قابلاً للتفسير. عطّله بدلاً من حذفه.",
  'Level {1} is deeper than the commission engine walks ({2}), so nobody standing on it could ever be paid. Partners deeper than this earn nothing and the trade pays the rungs above them.':
    'المستوى {1} أعمق مما يصل إليه محرك العمولات ({2})، لذا لن يُدفع لأي شريك عليه.',
  "{1} is {2}%, and a share of the product's figure cannot exceed 100% of it.":
    '{1} يساوي {2}%، ولا يمكن أن تتجاوز الحصة 100%.',
  'Level {1} already exists. A level IS its number, so edit that one rather than adding a second.':
    'المستوى {1} موجود مسبقاً. عدّله بدلاً من إضافة مستوى ثانٍ بالرقم نفسه.',
  'Level {1} does not exist.': 'المستوى {1} غير موجود.',
  '{1} {2} on level {3}, and a disabled level stops paying. Move them to another level first.{4}':
    '{1} {2} على المستوى {3}، والمستوى المعطّل يتوقف عن الدفع. انقلهم إلى مستوى آخر أولاً.{4}',
  'Level 1 cannot be removed — every partner chain starts there, so the ladder would stop paying entirely. Disable it if the broker has suspended partner commission.':
    'لا يمكن حذف المستوى 1 — فكل سلسلة شركاء تبدأ منه. عطّله إذا أوقف الوسيط عمولات الشركاء.',
  '{1} {2} on level {3}. Move them to another level before deleting it.{4}':
    '{1} {2} على المستوى {3}. انقلهم إلى مستوى آخر قبل حذفه.{4}',
  'Level {1} sits above {2} deeper level(s). Removing it would leave a gap, and the ladder has to run 1, 2, 3 … with none — delete the deepest level first.':
    'يقع المستوى {1} فوق {2} من المستويات الأعمق، وحذفه سيترك فجوة. احذف المستوى الأعمق أولاً.',
  'You are not a partner, so there is no partner overview to show.':
    'أنت لست شريكاً، لذا لا توجد نظرة عامة للشريك لعرضها.',
  'The amount to transfer must be greater than zero.': 'يجب أن يكون مبلغ التحويل أكبر من صفر.',
  'You have no {1} commission wallet. Earnings open one the first time a commission is credited.':
    'ليست لديك محفظة عمولات بعملة {1}. تُفتح المحفظة تلقائياً عند إيداع أول عمولة.',
  'Insufficient commission balance: {1} {2} available, {3} requested.':
    'رصيد العمولات غير كافٍ: المتاح {1} {2}، والمطلوب {3}.',
  'Only a partner can move commission earnings.': 'يمكن للشريك فقط تحويل أرباح العمولات.',
  'Your partner account is suspended, so commission cannot be moved. Contact support.':
    'حساب الشريك الخاص بك موقوف، لذا لا يمكن تحويل العمولات. تواصل مع الدعم.',

  // ── identity (sign-in, sessions, password) ──────────────────────────────────
  'No file was uploaded.': 'لم يتم تحميل أي ملف.',
  'This session has been ended for security reasons. Please log in again.':
    'تم إنهاء هذه الجلسة لأسباب أمنية. يُرجى تسجيل الدخول مرة أخرى.',
  'Your account has been suspended.': 'تم إيقاف حسابك.',
  'This session was renewed by another request. Please retry.':
    'تم تجديد هذه الجلسة بطلب آخر. يُرجى إعادة المحاولة.',
  'This email already has an OxShare account. Reset your password or sign in instead.':
    'هذا البريد الإلكتروني لديه حساب OxShare بالفعل. سجّل الدخول أو أعد تعيين كلمة المرور.',
  'Logged out successfully.': 'تم تسجيل الخروج بنجاح.',
  'Your session is no longer valid. Please sign in.': 'لم تعد جلستك صالحة. يُرجى تسجيل الدخول.',
  'Your current password is not correct.': 'كلمة المرور الحالية غير صحيحة.',
  'Your new password must be different from your current one.':
    'يجب أن تختلف كلمة المرور الجديدة عن كلمة المرور الحالية.',
  'Your password has been updated. {1} other session(s) were signed out.':
    'تم تحديث كلمة المرور. تم تسجيل الخروج من الجلسات الأخرى (عددها {1}).',
  'Your password has been updated.': 'تم تحديث كلمة المرور.',
  'That is the session you are using now. Use Log out to end it.':
    'هذه هي الجلسة التي تستخدمها الآن. استخدم «تسجيل الخروج» لإنهائها.',
  'That session no longer exists.': 'هذه الجلسة لم تعد موجودة.',
  'That session has been signed out.': 'تم تسجيل الخروج من هذه الجلسة.',
  'We have sent a 6-digit code to your email to confirm it.':
    'أرسلنا رمزاً مكوناً من 6 أرقام إلى بريدك الإلكتروني لتأكيده.',
  'The referral code {1} is not recognised. Check the link, or remove the code to continue without a partner.':
    'رمز الإحالة {1} غير معروف. تحقّق من الرابط، أو احذف الرمز للمتابعة دون شريك.',
  'Invalid or expired verification token.': 'رمز التحقق غير صالح أو منتهي الصلاحية.',
  'This link has already been used. Your email is verified — you can sign in.':
    'استُخدم هذا الرابط مسبقاً. تم تأكيد بريدك الإلكتروني — يمكنك تسجيل الدخول.',
  'Verification token has expired. Please request a new one.':
    'انتهت صلاحية رمز التحقق. يُرجى طلب رمز جديد.',
  'Email verified successfully. You can now log in.':
    'تم تأكيد البريد الإلكتروني بنجاح. يمكنك الآن تسجيل الدخول.',
  'If that address has an account waiting for confirmation, a new code is on its way.':
    'إذا كان لهذا العنوان حساب بانتظار التأكيد، فسيصلك رمز جديد قريباً.',
  'That code is incorrect or has expired. Check the latest email, or send a new code.':
    'الرمز غير صحيح أو منتهي الصلاحية. تحقّق من أحدث رسالة بريد إلكتروني، أو أرسل رمزاً جديداً.',
  'Your account has been suspended. Please contact support.':
    'تم إيقاف حسابك. يُرجى التواصل مع الدعم.',
  'If an account exists for that address, a reset link is on its way.':
    'إذا كان هناك حساب بهذا العنوان، فسيصلك رابط إعادة التعيين قريباً.',
  'This reset link is invalid or has expired. Please request a new one.':
    'رابط إعادة التعيين غير صالح أو منتهي الصلاحية. يُرجى طلب رابط جديد.',
  'Your password has been updated. Please sign in again.':
    'تم تحديث كلمة المرور. يُرجى تسجيل الدخول مرة أخرى.',
  'Invalid email or password.': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  'Confirm your email to sign in — we have sent a 6-digit code to your inbox.':
    'أكّد بريدك الإلكتروني لتسجيل الدخول — أرسلنا رمزاً مكوناً من 6 أرقام إلى بريدك الوارد.',
  'No refresh token provided.': 'لم يتم تقديم رمز التجديد.',
  'Invalid or expired refresh token.': 'رمز التجديد غير صالح أو منتهي الصلاحية.',
  'User account not found.': 'حساب المستخدم غير موجود.',
  'Session has been revoked. Please log in again.': 'تم إلغاء الجلسة. يُرجى تسجيل الدخول مرة أخرى.',
  'Enter the 6-digit code from the email.':
    'أدخل الرمز المكون من 6 أرقام الوارد في البريد الإلكتروني.',
  'Please verify your email address before accessing this resource.':
    'يُرجى تأكيد بريدك الإلكتروني قبل الوصول إلى هذه الصفحة.',
  'Your identity must be verified before you can do this.':
    'يجب التحقق من هويتك قبل أن تتمكن من القيام بذلك.',
  'Your identity must be verified before you can move money. Complete verification to continue.':
    'يجب التحقق من هويتك قبل أن تتمكن من تحويل الأموال. أكمل التحقق للمتابعة.',
  'Please log in again.': 'يُرجى تسجيل الدخول مرة أخرى.',
  'User not found. Please log in again.': 'المستخدم غير موجود. يُرجى تسجيل الدخول مرة أخرى.',
  'That session has been signed out. Please log in again.':
    'تم تسجيل الخروج من هذه الجلسة. يُرجى تسجيل الدخول مرة أخرى.',
  'Your password was changed. Please sign in again.':
    'تم تغيير كلمة المرور. يُرجى تسجيل الدخول مرة أخرى.',
  'Invalid or expired token.': 'الرمز غير صالح أو منتهي الصلاحية.',

  // ── payments: channels, deposits, payouts ───────────────────────────────────
  '{1} is not currently available. Choose another method.':
    '{1} غير متاحة حالياً. اختر طريقة أخرى.',
  'Say why this channel is being switched off.': 'اذكر سبب إيقاف هذه القناة.',
  'A reason is required to switch a channel off.': 'يلزم ذكر سبب لإيقاف القناة.',
  'No deposit matches that reference.': 'لا يوجد إيداع يطابق هذا المرجع.',
  'The provider never reported an amount for this deposit — there is nothing to credit from here. Credit the wallet by hand once the amount is confirmed.':
    'لم يُبلغ المزوّد عن مبلغ لهذا الإيداع — لا يوجد ما يُودَع من هنا. أودِع في المحفظة يدوياً بعد تأكيد المبلغ.',
  'The reported amount rounds to nothing.': 'المبلغ المُبلَّغ عنه يُقرَّب إلى صفر.',
  'This deposit was finished by somebody else meanwhile.':
    'أنهى شخص آخر هذا الإيداع في هذه الأثناء.',
  'Only a deposit paid on a provider’s page is finished here.':
    'لا يُنهى هنا إلا إيداع مدفوع عبر صفحة المزوّد.',
  'Only an unfinished deposit flagged for a person is finished here.':
    'لا يُنهى هنا إلا إيداع غير مكتمل ومُحال إلى موظف.',
  'Only a payout a provider sends is finished here.': 'لا تُنهى هنا إلا دفعة يرسلها المزوّد.',
  'This payout is not waiting for a person any more — it may be finished already.':
    'هذه الدفعة لم تعد بانتظار موظف — ربما اكتملت بالفعل.',
  'It never reached {1}: resend it, or cancel it, instead.':
    'لم تصل إلى {1} أبداً: أعد إرسالها أو ألغِها بدلاً من ذلك.',
  "{1} may still answer for this payout. The reconciler settles it from {2}'s records first — try again {3} minutes after it was sent.":
    'قد يردّ {1} بشأن هذه الدفعة. تتم التسوية أولاً من سجلات {2} — حاول مرة أخرى بعد {3} دقيقة من إرسالها.',
  'Say what you found, for the record.': 'اذكر ما وجدته، للتوثيق.',
  'Give the reference of the payment that reached the client.':
    'أدخل مرجع الدفعة التي وصلت إلى العميل.',
  'That reference already belongs to another movement.': 'هذا المرجع يخص حركة أخرى بالفعل.',
  'This withdrawal has a payout in flight whose outcome is not known yet. Wait for reconciliation to confirm whether the provider made it, then cancel.':
    'لطلب السحب هذا دفعة جارية لم تُعرف نتيجتها بعد. انتظر التسوية لتأكيد ما إذا نفّذها المزوّد، ثم ألغِه.',
  '{1} has already been sent this payout and it cannot be recalled. Act on its outcome instead.':
    'أُرسلت هذه الدفعة إلى {1} بالفعل ولا يمكن استردادها. تصرّف وفق نتيجتها بدلاً من ذلك.',
  '{1} is already processing this payout — it can no longer be cancelled. It will settle or fail shortly; act on the outcome instead.':
    'يعالج {1} هذه الدفعة بالفعل — لم يعد بالإمكان إلغاؤها. ستُسوّى أو تفشل قريباً؛ تصرّف وفق النتيجة.',
  'Say what this movement was.': 'اذكر ماهية هذه الحركة.',
  'Keep the note under {1} characters.': 'يجب ألا يتجاوز عدد أحرف الملاحظة {1}.',
  'There is no open record with this id; it may be explained already.':
    'لا يوجد سجل مفتوح بهذا المعرّف؛ ربما تم توضيحه بالفعل.',
  'logoUrl must be an https URL or a path returned by POST /admin/payment-methods/logo':
    'يجب أن يكون رابط الشعار رابط https أو مساراً صادراً عن POST /admin/payment-methods/logo',
  'ownMinAmount must be an amount, e.g. 100 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأدنى مبلغاً، مثل 100 أو 5000000 (حتى 8 منازل عشرية)',
  'ownMaxAmount must be an amount, e.g. 100 or 5000000 (up to 8 decimals)':
    'يجب أن يكون الحد الأقصى مبلغاً، مثل 100 أو 5000000 (حتى 8 منازل عشرية)',
  'Each country must be a 2-letter ISO code.': 'يجب أن يكون كل بلد رمز ISO من حرفين.',
  'id must be f_ followed by 6-16 letters or digits':
    'يجب أن يكون المعرّف f_ متبوعاً بـ 6 إلى 16 حرفاً أو رقماً',
  'from must be a YYYY-MM-DD date': 'يجب أن يكون تاريخ البداية بصيغة YYYY-MM-DD',
  'to must be a YYYY-MM-DD date': 'يجب أن يكون تاريخ النهاية بصيغة YYYY-MM-DD',
  'amount must be a positive decimal string with at most 8 decimal places':
    'يجب أن يكون المبلغ رقماً موجباً بثماني منازل عشرية كحد أقصى',
  'The key {1} is reserved: the platform files its own manual credits under it.':
    'المفتاح {1} محجوز: تسجّل المنصة إيداعاتها اليدوية تحته.',
  "The key {1} is reserved: keys starting with manual_ name deposits and the desk's own credits.":
    'المفتاح {1} محجوز: المفاتيح التي تبدأ بـ manual_ مخصصة لإيداعات المكتب.',
  'The internal name cannot be empty.': 'لا يمكن أن يكون الاسم الداخلي فارغاً.',
  'Unknown currency {1}.': 'عملة غير معروفة: {1}.',
  '{1} is not set up, so clients could not use this method. Set up and switch on {2} under Payment providers first.':
    '{1} غير مُعدّ، لذا لن يتمكن العملاء من استخدام هذه الطريقة. أعدّ {2} وفعّله من مزوّدي الدفع أولاً.',
  '{1} is switched off, so clients could not use this method. Set up and switch on {2} under Payment providers first.':
    '{1} متوقف، لذا لن يتمكن العملاء من استخدام هذه الطريقة. أعدّ {2} وفعّله من مزوّدي الدفع أولاً.',
  'Unknown payment method {1}.': 'طريقة دفع غير معروفة: {1}.',
  'The minimum {1} deposit is {2} {3}.': 'الحد الأدنى للإيداع عبر {1} هو {2} {3}.',
  'The maximum {1} deposit is {2} {3}.': 'الحد الأقصى للإيداع عبر {1} هو {2} {3}.',
  'A payment method with the key {1} already exists.': 'توجد طريقة دفع بالمفتاح {1} مسبقاً.',
  'Another deposit method is already called “{1}” internally.':
    'توجد طريقة إيداع أخرى بالاسم الداخلي «{1}» مسبقاً.',
  '{1} has been used by transactions and cannot be deleted. Disable it instead.':
    'استُخدمت {1} في معاملات ولا يمكن حذفها. عطّلها بدلاً من ذلك.',
  'No receipt was uploaded.': 'لم يتم تحميل أي إيصال.',
  "{1} is the desk's own; no method can use it.": '{1} خاص بالمكتب؛ لا يمكن لأي طريقة استخدامه.',
  '{1} · {2} does not carry {3}.': '{1} · {2} لا يدعم {3}.',
  '{1} is settled by {2}; it takes no receipt.': 'تتم تسوية {1} عبر {2}؛ ولا يتطلب إيصالاً.',
  '{1} cannot open a hosted payment.': 'لا يمكن لـ {1} فتح صفحة دفع.',
  '{1} cannot report on a hosted payment.': 'لا يمكن لـ {1} الإبلاغ عن صفحة دفع.',
  '{1} · {2} has no hosted payment page.': 'لا توجد صفحة دفع لـ {1} · {2}.',
  'There is no payment provider "{1}".': 'لا يوجد مزوّد دفع باسم "{1}".',
  '{1} has no {2} channel "{3}".': 'لا توجد لدى {1} قناة {2} باسم "{3}".',
  '{1} keeps no exchange log.': 'لا يحتفظ {1} بسجل تبادل.',
  'A sandbox configuration cannot be used on a production deployment: its events would move real money. Keep it live here, and use sandbox on a test deployment.':
    'لا يمكن استخدام إعداد تجريبي (sandbox) على بيئة الإنتاج لأن أحداثه ستنقل أموالاً حقيقية.',
  '{1} cannot be switched on without: {2}.': 'لا يمكن تفعيل {1} دون: {2}.',
  "{1} is the desk's own; it has no switch.": '{1} خاص بالمكتب؛ وليس له مفتاح تشغيل.',
  '{1} has no generated secret "{2}".': 'لا توجد لدى {1} قيمة سرية مولّدة باسم "{2}".',
  'Save {1} first: the new {2} is pasted into {3}’s dashboard, which is pointless for a connection that is not set up.':
    'احفظ {1} أولاً: تُلصق القيمة الجديدة {2} في لوحة تحكم {3}، ولا فائدة من ذلك لاتصال غير مُعدّ.',
  '{1} has no connection to test.': 'لا يوجد لدى {1} اتصال لاختباره.',
  '{1} is built in: it has no settings to change.': '{1} مدمج: ليست له إعدادات لتغييرها.',
  '{1} has no setting "{2}".': 'لا يوجد لدى {1} إعداد باسم "{2}".',
  '{1} has no secret "{2}".': 'لا توجد لدى {1} قيمة سرية باسم "{2}".',
  '{1} is generated by the platform, never typed. Rotate it instead.':
    'تولّد المنصة {1} ولا يُكتب يدوياً. جدّده بدلاً من ذلك.',
  '{1} · {2} is not a URL.': '{1} · {2} ليس رابطاً.',
  '{1} · {2} must be https:// — every payment and payout goes to it.':
    'يجب أن يبدأ {1} · {2} بـ https:// — فكل دفعة تمر عبره.',
  '{1} must be text.': 'يجب أن يكون {1} نصاً.',
  '{1} is longer than {2} characters.': 'يتجاوز عدد أحرف {1} الحد {2}.',
  'Rival is not configured on this deployment. Set the base URL and API key in Settings → Payments.':
    'لم يُضبط Rival على هذا النظام. اضبط الرابط الأساسي ومفتاح API من الإعدادات ← المدفوعات.',
  'The payment platform did not answer. The operation may or may not have been recorded — it will be reconciled, do not retry blindly.':
    'لم تستجب منصة الدفع. ربما سُجّلت العملية وربما لا — ستتم مطابقتها، فلا تُعد المحاولة عشوائياً.',
  'The payment platform could not be reached.': 'تعذّر الوصول إلى منصة الدفع.',
  'The payment provider gave no usable answer; the payment state is unknown and will be reconciled.':
    'لم يقدّم مزوّد الدفع رداً واضحاً؛ حالة الدفع غير معروفة وستتم مطابقتها.',
  'The payment platform has no commission rule covering this amount — the deposit method is misconfigured on the Rival side. Nothing was created.':
    'لا تملك منصة الدفع قاعدة عمولة تغطي هذا المبلغ. لم يُنشأ أي شيء.',
  'The payment platform rejected our credentials. Check the Rival API key in Settings → Payments.':
    'رفضت منصة الدفع بيانات الاعتماد. تحقّق من مفتاح Rival API في الإعدادات ← المدفوعات.',
  'The payment platform reports insufficient company balance for this payout.':
    'تُبلغ منصة الدفع عن رصيد غير كافٍ للشركة لهذه الدفعة.',
  'The payment platform kept refusing with a write conflict.':
    'استمرت منصة الدفع في الرفض بسبب تعارض في الكتابة.',
  'The payment platform does not know this reference.': 'لا تعرف منصة الدفع هذا المرجع.',
  'The payment platform failed mid-operation; the result is unknown and will be reconciled.':
    'تعطّلت منصة الدفع أثناء العملية؛ النتيجة غير معروفة وستتم مطابقتها.',
  'The payment platform refused the request.': 'رفضت منصة الدفع الطلب.',
  'The payment platform collects to {1} decimal places and cannot take {2} exactly. Crediting a different figure than the client pays is refused.':
    'تحصّل منصة الدفع حتى {1} منازل عشرية ولا يمكنها قبول {2} بدقة.',
  'The payment platform settles to {1} decimal places and cannot send {2} exactly. Paying the rounded amount would keep the difference from the client, so this payout is refused until the amount is corrected.':
    'تسوّي منصة الدفع حتى {1} منازل عشرية ولا يمكنها إرسال {2} بدقة، لذا رُفضت الدفعة حتى تصحيح المبلغ.',
  'The payment platform recorded the deposit but could not produce a payment page. It will be retried automatically — do not create a second deposit.':
    'سجّلت منصة الدفع الإيداع لكنها لم تتمكن من إنشاء صفحة الدفع. ستُعاد المحاولة تلقائياً — لا تُنشئ إيداعاً ثانياً.',
  'Rival has no hosted payment for {1}.': 'لا توجد لدى Rival صفحة دفع لـ {1}.',
  'The destination for a Whish withdrawal must be a phone number — 6 to 15 digits, optionally with +, spaces, dashes or parentheses.':
    'يجب أن تكون وجهة السحب عبر Whish رقم هاتف — من 6 إلى 15 رقماً، ويمكن أن يتضمن + أو مسافات أو شرطات أو أقواساً.',
  'That does not look like a valid Lebanese mobile number. After +961 there should be 8 digits (or 7 when the number starts with 3).':
    'لا يبدو هذا رقم هاتف محمول لبنانياً صالحاً. يجب أن يلي ‎+961 ثمانية أرقام (أو سبعة إذا بدأ الرقم بـ 3).',
  'A TRC20 address starts with T and is 34 characters long.':
    'يبدأ عنوان TRC20 بالحرف T ويتكون من 34 حرفاً.',
  'This is not a valid TRC20 address. Check it for a typing mistake.':
    'هذا ليس عنوان TRC20 صالحاً. تحقّق من عدم وجود خطأ في الكتابة.',
  'This is the zero address. Money sent there is lost.':
    'هذا هو العنوان الصفري. الأموال المرسلة إليه تضيع.',
  'This is the USDT token contract, not a wallet. Money sent there is lost.':
    'هذا عقد رمز USDT وليس محفظة. الأموال المرسلة إليه تضيع.',
  'An ERC20 address is 0x followed by 40 letters and digits (0–9, a–f).':
    'يتكون عنوان ERC20 من 0x متبوعاً بـ 40 حرفاً ورقماً (0–9، a–f).',
  'The capital letters in this address do not match its checksum, so it was probably mistyped. Copy it again from the wallet.':
    'الأحرف الكبيرة في هذا العنوان لا تطابق رمز التحقق الخاص به، لذا ربما كُتب بشكل خاطئ. انسخه مجدداً من المحفظة.',
  '3pay has no network for {1}.': 'لا توجد لدى 3pay شبكة لـ {1}.',
  '3pay pays to 2 decimal places and cannot send {1} exactly; the payout is refused rather than paid a rounded amount.':
    'يدفع 3pay حتى منزلتين عشريتين ولا يمكنه إرسال {1} بدقة؛ لذا رُفضت الدفعة بدلاً من دفع مبلغ مقرَّب.',
  '3pay is at its request limit; nothing was sent. Retry in about {1}s.':
    'بلغ 3pay حد الطلبات؛ لم يُرسل شيء. أعد المحاولة بعد نحو {1} ثانية.',
  'USDT deposits are unavailable: this deployment has no public API address for 3pay to report payments to (API_PUBLIC_URL).':
    'إيداعات USDT غير متاحة: لا يوجد عنوان API عام لهذا النظام (API_PUBLIC_URL).',
  'The payment provider did not confirm the payment page. Check your transactions in a few minutes before trying again.':
    'لم يؤكد مزوّد الدفع صفحة الدفع. تحقّق من معاملاتك بعد بضع دقائق قبل المحاولة مرة أخرى.',
  '3pay answered about invoice {1} when asked about {2}.':
    'ردّ 3pay بشأن الفاتورة {1} عند السؤال عن {2}.',
  'Too many 3pay payments match this reference to judge.':
    'عدد كبير جداً من دفعات 3pay يطابق هذا المرجع بحيث يتعذّر الحكم.',
  '3pay holds {1} payments for {2} ({3}); match it by hand.':
    'لدى 3pay {1} دفعات لـ {2} ({3})؛ طابقها يدوياً.',
  'USDT payments are busy right now. Please try again in a minute.':
    'مدفوعات USDT مزدحمة حالياً. يُرجى المحاولة مرة أخرى بعد دقيقة.',
  'The payment provider refused this payment: {1}': 'رفض مزوّد الدفع هذه الدفعة: {1}',
  'USDT deposits are unavailable right now. Please try again later.':
    'إيداعات USDT غير متاحة حالياً. يُرجى المحاولة لاحقاً.',
  '3pay has no hosted payment for {1}.': 'لا توجد لدى 3pay صفحة دفع لـ {1}.',

  // ── payments: transactions, transfers, withdrawals ──────────────────────────
  '{1} pays out {2} only — choose a {3} wallet or another method.':
    'تدفع {1} بعملة {2} فقط — اختر محفظة بعملة {3} أو طريقة أخرى.',
  '{1} pays out at least {2} {3}.': 'الحد الأدنى للسحب عبر {1} هو {2} {3}.',
  '{1} settles {2} to {3} decimal place. The most you can withdraw from this request is {4} {5}.':
    'تسوّي {1} عملة {2} حتى {3} منزلة عشرية. أقصى ما يمكنك سحبه بهذا الطلب هو {4} {5}.',
  '{1} settles {2} to {3} decimal places. The most you can withdraw from this request is {4} {5}.':
    'تسوّي {1} عملة {2} حتى {3} منازل عشرية. أقصى ما يمكنك سحبه بهذا الطلب هو {4} {5}.',
  'Enter where the money should be sent.': 'أدخل الجهة التي يجب إرسال الأموال إليها.',
  'User not found.': 'المستخدم غير موجود.',
  'Withdrawals require a verified account (KYC level 1).':
    'يتطلب السحب حساباً موثَّقاً (المستوى 1 من التحقق من الهوية).',
  'Transaction not found.': 'المعاملة غير موجودة.',
  'Only a pending withdrawal can be approved; this one is {1}.':
    'لا يمكن قبول إلا طلب سحب قيد الانتظار؛ حالة هذا الطلب: {1}.',
  'Only a pending withdrawal can be rejected; this one is {1}.':
    'لا يمكن رفض إلا طلب سحب قيد الانتظار؛ حالة هذا الطلب: {1}.',
  'Only an approved withdrawal can be settled; this one is {1}.':
    'لا يمكن تسوية إلا طلب سحب مقبول؛ حالة هذا الطلب: {1}.',
  'Only an approved withdrawal can be marked failed; this one is {1}.':
    'لا يمكن وسم طلب سحب بالفشل إلا إذا كان مقبولاً؛ حالة هذا الطلب: {1}.',
  'Deposit amount must be positive.': 'يجب أن يكون مبلغ الإيداع موجباً.',
  'Payment method "{1}" is configured to need a receipt and is also a hosted gateway. Those cannot both be true — fix the method before taking deposits on it.':
    'طريقة الدفع "{1}" مُعدّة لتطلب إيصالاً وهي أيضاً بوابة دفع. صحّح إعداد الطريقة قبل قبول الإيداعات عليها.',
  'This payment method needs a picture of your transfer receipt. Please attach one.':
    'تتطلب طريقة الدفع هذه صورة إيصال التحويل. يُرجى إرفاقها.',
  'Payment method "{1}" does not take a receipt.': 'طريقة الدفع "{1}" لا تقبل إيصالاً.',
  '{1} takes {2} to {3} decimal place. Use {4} {5} instead.':
    'تقبل {1} عملة {2} حتى {3} منزلة عشرية. استخدم {4} {5} بدلاً من ذلك.',
  '{1} takes {2} to {3} decimal places. Use {4} {5} instead.':
    'تقبل {1} عملة {2} حتى {3} منازل عشرية. استخدم {4} {5} بدلاً من ذلك.',
  'Trading account not found.': 'حساب التداول غير موجود.',
  'Only live trading accounts can be funded. Demo accounts trade practice money and are not linked to your wallet.':
    'لا يمكن تمويل إلا حسابات التداول الحقيقية. الحسابات التجريبية تتداول بأموال افتراضية وليست مرتبطة بمحفظتك.',
  'That transaction is not a deposit.': 'هذه المعاملة ليست إيداعاً.',
  'That deposit settles from the payment provider, not by hand. Nothing was credited.':
    'تتم تسوية هذا الإيداع من مزوّد الدفع وليس يدوياً. لم يُودَع أي شيء.',
  'Only a pending deposit can be approved; this one is {1}.':
    'لا يمكن قبول إلا إيداع قيد الانتظار؛ حالة هذا الإيداع: {1}.',
  'That deposit settles from the payment provider, so it cannot be rejected by hand.':
    'تتم تسوية هذا الإيداع من مزوّد الدفع، لذا لا يمكن رفضه يدوياً.',
  'Only a pending deposit can be rejected; this one is {1}.':
    'لا يمكن رفض إلا إيداع قيد الانتظار؛ حالة هذا الإيداع: {1}.',
  'Malformed cursor. Omit it to start from the first page.':
    'مؤشر الصفحات غير صالح. احذفه للبدء من الصفحة الأولى.',
  'Withdrawal amount must be positive.': 'يجب أن يكون مبلغ السحب موجباً.',
  'The minimum withdrawal is {1} {2}.': 'الحد الأدنى للسحب هو {1} {2}.',
  'The maximum single withdrawal is {1} {2}. Please split the request or contact support.':
    'الحد الأقصى لعملية سحب واحدة هو {1} {2}. يُرجى تقسيم الطلب أو التواصل مع الدعم.',
  'That withdrawal method is not available.': 'طريقة السحب هذه غير متاحة.',
  'Transfer not found.': 'التحويل غير موجود.',
  'Transfer amount must be positive.': 'يجب أن يكون مبلغ التحويل موجباً.',
  'Transfers require a verified account (KYC level 1).':
    'تتطلب التحويلات حساباً موثَّقاً (المستوى 1 من التحقق من الهوية).',
  'That trading account is {1} and cannot be used for transfers.':
    'حالة حساب التداول هذا: {1}، ولا يمكن استخدامه للتحويلات.',
  'That trading account is denominated in {1}, and this transfer is in {2}. Transfers do not convert between currencies.':
    'عملة حساب التداول هذا {1}، وهذا التحويل بعملة {2}. لا تُحوِّل التحويلات بين العملات.',
  'That trading account holds {1} {2}, of which {3} is already committed to a transfer in progress, so {4} cannot be moved out of it.':
    'يحتوي حساب التداول هذا على {1} {2}، منها {3} مخصصة لتحويل جارٍ، لذا لا يمكن تحويل {4} منه.',
  'That trading account holds {1} {2}, so {3} cannot be moved out of it.':
    'يحتوي حساب التداول هذا على {1} {2}، لذا لا يمكن تحويل {3} منه.',
  'Only a pending transfer can settle; this one is {1}.':
    'لا يمكن تسوية إلا تحويل قيد الانتظار؛ حالة هذا التحويل: {1}.',
  'Only a pending transfer can fail; this one is {1}.':
    'لا يمكن أن يفشل إلا تحويل قيد الانتظار؛ حالة هذا التحويل: {1}.',
  'Transfers in {1} go to {2} decimal places. Use {3} instead.':
    'تتم التحويلات بعملة {1} حتى {2} منازل عشرية. استخدم {3} بدلاً من ذلك.',
  'That idempotency key was already used for a different transfer. Use a new key.':
    'استُخدم مفتاح منع التكرار هذا لتحويل مختلف. استخدم مفتاحاً جديداً.',
  'A withdrawal method with the key {1} already exists.': 'توجد طريقة سحب بالمفتاح {1} مسبقاً.',
  'Unknown withdrawal method {1}.': 'طريقة سحب غير معروفة: {1}.',
  '{1} has been used by withdrawals and cannot be deleted. Disable it instead.':
    'استُخدمت {1} في عمليات سحب ولا يمكن حذفها. عطّلها بدلاً من ذلك.',
  'Another withdrawal method is already called “{1}” internally.':
    'توجد طريقة سحب أخرى بالاسم الداخلي «{1}» مسبقاً.',

  // ── products and agencies ────────────────────────────────────────────────────
  'A demo product cannot carry a commission type: practice trades never pay partner commission, so the type would look configured and pay nobody.':
    'لا يمكن ربط منتج تجريبي بنوع عمولة: فصفقات التدريب لا تدفع عمولات للشركاء.',
  'Product not found.': 'المنتج غير موجود.',
  "A product's type is fixed when it is created. To change what is offered as demo, create the product you want and move the groups instead.":
    'يُحدَّد نوع المنتج عند إنشائه. لتغيير ما يُعرض كتجريبي، أنشئ المنتج المطلوب وانقل المجموعات إليه.',
  'This product is sold by {1}. Remove it from those agencies first, or disable it instead — disabling stops it being sold and leaves open accounts alone.':
    'تبيع هذا المنتج: {1}. أزله من تلك الوكالات أولاً، أو عطّله بدلاً من ذلك.',
  "'{1}' is a demo product — it takes demo groups only. Attach live groups to a real product instead.":
    "'{1}' منتج تجريبي — يقبل المجموعات التجريبية فقط. اربط المجموعات الحقيقية بمنتج حقيقي.",
  "'{1}' is a real product — it takes live groups only. Demo groups belong on a demo product, which is offered to every client.":
    "'{1}' منتج حقيقي — يقبل المجموعات الحقيقية فقط. المجموعات التجريبية تتبع منتجاً تجريبياً.",
  "'{1}' is a demo product, and demo accounts are never funded from the wallet, so its groups take no minimum deposit.":
    "'{1}' منتج تجريبي، والحسابات التجريبية لا تُموَّل من المحفظة، لذا لا تحمل مجموعاته حداً أدنى للإيداع.",
  'A minimum deposit must be above zero. Leave it empty for none.':
    'يجب أن يكون الحد الأدنى للإيداع أكبر من صفر. اتركه فارغاً لعدم تحديد حد.',
  'MT5 does not report a group called "{1}". Choose one from the list — if the group is new, the broker may not have granted this manager account access to it.':
    'لا يُبلغ MT5 عن مجموعة باسم "{1}". اختر مجموعة من القائمة.',
  '"{1}" is already attached to \'{2}\'.': '"{1}" مرتبطة بالفعل بـ \'{2}\'.',
  '\'{1}\' already has a {2} {3} group, "{4}". A product holds one group per currency, because a client opening an account picks a product and a currency and must land in exactly one group. Remove "{5}" from \'{6}\' first, or attach "{7}" to another product.':
    'لدى \'{1}\' مجموعة {2} {3} بالفعل، وهي "{4}". يحتوي المنتج على مجموعة واحدة لكل عملة. أزل "{5}" من \'{6}\' أولاً، أو اربط "{7}" بمنتج آخر.',
  'That group is not attached to this product.': 'هذه المجموعة غير مرتبطة بهذا المنتج.',
  'Agency not found.': 'الوكالة غير موجودة.',
  'Partners are appointed under this agency. Move them to another one first, or disable it — disabling stops new applications and leaves the partners in place.':
    'يوجد شركاء معيّنون تحت هذه الوكالة. انقلهم إلى وكالة أخرى أولاً، أو عطّلها بدلاً من ذلك.',
  'One of those products does not exist. Reload and try again.':
    'أحد هذه المنتجات غير موجود. أعد التحميل ثم حاول مرة أخرى.',
  'Demo products are offered to every client automatically — agencies carry real products only.':
    'تُعرض المنتجات التجريبية على كل عميل تلقائياً — تحمل الوكالات المنتجات الحقيقية فقط.',

  // ── profile ──────────────────────────────────────────────────────────────────
  'Client not found.': 'العميل غير موجود.',
  'The corrected details do not pass verification: {1} This is a fact about the RECORD, not about what you typed — a verified record cannot hold these values, so this is a rejection rather than an edit.':
    'البيانات المصحّحة لا تجتاز التحقق: {1} لا يمكن لسجل موثَّق أن يحمل هذه القيم، لذا يلزم الرفض بدلاً من التعديل.',
  'This correction applies to a VERIFIED record, and this one no longer is.':
    'ينطبق هذا التصحيح على سجل موثَّق، وهذا السجل لم يعد كذلك.',
  'A verified detail changes only with a reason — it is recorded on the verification.':
    'لا تتغير البيانات الموثَّقة إلا مع ذكر سبب — يُسجَّل السبب في طلب التحقق.',
  'Give a reason for changing a verified detail.': 'اذكر سبب تغيير البيانات الموثَّقة.',
  "The client's verification changed while you were editing. Reload and try again.":
    'تغيّر تحقق العميل أثناء التعديل. أعد التحميل ثم حاول مرة أخرى.',

  // ── trading ──────────────────────────────────────────────────────────────────
  'page must be a whole number': 'يجب أن يكون رقم الصفحة عدداً صحيحاً',
  'page starts at 1': 'يبدأ ترقيم الصفحات من 1',
  'limit must be a whole number': 'يجب أن يكون الحد عدداً صحيحاً',
  'limit must be at least 1': 'يجب ألا يقل الحد عن 1',
  'limit cannot exceed {1}': 'يجب ألا يزيد الحد عن {1}',
  'amount must be a positive decimal with up to 2 places':
    'يجب أن يكون المبلغ رقماً موجباً بمنزلتين عشريتين كحد أقصى',
  'startingBalance must be a positive decimal with up to 2 places':
    'يجب أن يكون الرصيد الافتتاحي رقماً موجباً بمنزلتين عشريتين كحد أقصى',
  'The MT5 bridge secret is not configured on this server.':
    'لم يُضبط المفتاح السري لجسر MT5 على هذا الخادم.',
  'Invalid or missing X-Bridge-Secret.': 'قيمة X-Bridge-Secret غير صالحة أو مفقودة.',
  'balance must be a decimal string': 'يجب أن يكون الرصيد رقماً عشرياً',
  'credit must be a decimal string': 'يجب أن يكون الائتمان رقماً عشرياً',
  'login must be the MT5 login number': 'يجب أن يكون رقم الدخول رقم دخول MT5',
  'volume must be a decimal string': 'يجب أن يكون الحجم رقماً عشرياً',
  'price must be a decimal string': 'يجب أن يكون السعر رقماً عشرياً',
  'profit must be a decimal string': 'يجب أن يكون الربح رقماً عشرياً',
  'commission must be a decimal string': 'يجب أن تكون العمولة رقماً عشرياً',
  'swap must be a decimal string': 'يجب أن تكون قيمة المبادلة رقماً عشرياً',
  'equity must be a decimal string': 'يجب أن تكون حقوق الملكية رقماً عشرياً',
  'margin must be a decimal string': 'يجب أن يكون الهامش رقماً عشرياً',
  'marginFree must be a decimal string': 'يجب أن يكون الهامش الحر رقماً عشرياً',
  'marginLevel must be a decimal string': 'يجب أن يكون مستوى الهامش رقماً عشرياً',
  'priceOpen must be a decimal string': 'يجب أن يكون سعر الفتح رقماً عشرياً',
  'priceCurrent must be a decimal string': 'يجب أن يكون السعر الحالي رقماً عشرياً',
  'stopLoss must be a decimal string': 'يجب أن يكون وقف الخسارة رقماً عشرياً',
  'takeProfit must be a decimal string': 'يجب أن يكون جني الأرباح رقماً عشرياً',
  'A sync is already running. Its accounts appear on the list as it records them.':
    'هناك مزامنة جارية بالفعل. تظهر حساباتها في القائمة عند تسجيلها.',
  'The MT5 bridge is not configured on this deployment, so there is nothing to sync.':
    'لم يُضبط جسر MT5 على هذا النظام، لذا لا يوجد ما تتم مزامنته.',
  'You already have an account named "{1}". Choose a different name.':
    'لديك بالفعل حساب باسم "{1}". اختر اسماً مختلفاً.',
  'Enter a name for this account.': 'أدخل اسماً لهذا الحساب.',
  'That name is too long — use 128 characters or fewer.':
    'هذا الاسم طويل جداً — استخدم 128 حرفاً أو أقل.',
  'Only demo accounts can be topped up this way. To add money to a live account, transfer it from your wallet.':
    'لا يمكن شحن إلا الحسابات التجريبية بهذه الطريقة. لإضافة أموال إلى حساب حقيقي، حوّلها من محفظتك.',
  'Enter a valid amount.': 'أدخل مبلغاً صالحاً.',
  'Enter an amount greater than zero.': 'أدخل مبلغاً أكبر من صفر.',
  'MT5 has no account with login {1}.': 'لا يوجد في MT5 حساب برقم الدخول {1}.',
  'MT5 account {1} is already linked to a client. Moving an account between clients re-attributes its commission and is not done from here.':
    'حساب MT5 رقم {1} مرتبط بعميل بالفعل. لا يتم نقل الحسابات بين العملاء من هنا.',
  'MT5 account {1} is in {2}, which this platform does not hold. Add the currency first, then link the account.':
    'حساب MT5 رقم {1} بعملة {2}، وهي غير متوفرة على هذه المنصة. أضف العملة أولاً ثم اربط الحساب.',
  'MT5 account {1} was just assigned by someone else.': 'خصّص شخص آخر حساب MT5 رقم {1} للتو.',
  'MT5 account {1} was just linked by someone else.': 'ربط شخص آخر حساب MT5 رقم {1} للتو.',
  'This account has no MT5 group recorded, so no product can be checked against it.':
    'لا توجد مجموعة MT5 مسجلة لهذا الحساب، لذا لا يمكن مطابقته مع أي منتج.',
  'That product does not sell the MT5 group "{1}". Choose one that carries this group, or attach the group to it first.':
    'هذا المنتج لا يبيع مجموعة MT5 "{1}". اختر منتجاً يتضمنها، أو اربط المجموعة به أولاً.',
  'The MT5 bridge is not configured on this deployment, so trading accounts cannot be opened or funded. Set MT5_BRIDGE_URL and MT5_BRIDGE_API_KEY.':
    'لم يُضبط جسر MT5 على هذا النظام، لذا لا يمكن فتح حسابات التداول أو تمويلها.',
  'Your account could not be registered. Our team has been alerted and will finish setting it up; you do not need to try again.':
    'تعذّر تسجيل حسابك. أُبلغ فريقنا وسيُكمل إعداده؛ لا حاجة إلى إعادة المحاولة.',
  'An MT5 login is a number, e.g. 5000123.': 'رقم دخول MT5 هو رقم، مثل 5000123.',
  'The chosen product does not sell the MT5 group "{1}". Choose a product that carries this group, or attach the group to it first.':
    'المنتج المختار لا يبيع مجموعة MT5 "{1}". اختر منتجاً يتضمنها، أو اربط المجموعة به أولاً.',
  'The MT5 group "{1}" is sold by more than one product ({2}). Choose which product this account is opened under.':
    'تُباع مجموعة MT5 "{1}" ضمن أكثر من منتج ({2}). اختر المنتج الذي سيُفتح هذا الحساب تحته.',
  "You already have {1} '{2}' account, the most one client may hold. Contact support if you need another.":
    'لديك بالفعل {1} حساب من النوع «{2}»، وهو الحد الأقصى للعميل الواحد. تواصل مع الدعم إذا احتجت إلى حساب آخر.',
  "You already have {1} '{2}' accounts, the most one client may hold. Contact support if you need another.":
    'لديك بالفعل {1} حسابات من النوع «{2}»، وهو الحد الأقصى للعميل الواحد. تواصل مع الدعم إذا احتجت إلى حساب آخر.',
  'The minimum transfer into this account is {1} {2}.':
    'الحد الأدنى للتحويل إلى هذا الحساب هو {1} {2}.',
  'minDeposit must be an amount, e.g. 100 or 250.50 (up to 8 decimals)':
    'يجب أن تكون القيمة مبلغاً، مثل 100 أو 250.50 (حتى 8 خانات عشرية).',
  'A live account cannot be opened with a starting balance. Fund it from your wallet once it is open.':
    'لا يمكن فتح حساب حقيقي برصيد افتتاحي. موّله من محفظتك بعد فتحه.',
  'This account is not fully set up yet. Please contact support.':
    'لم يكتمل إعداد هذا الحساب بعد. يُرجى التواصل مع الدعم.',
  'This account could not be found on the trading server. Please contact support.':
    'تعذّر العثور على هذا الحساب على خادم التداول. يُرجى التواصل مع الدعم.',
  'An MT5 balance operation requires an idempotency key.':
    'تتطلب عملية الرصيد في MT5 مفتاح منع التكرار.',
  'The MT5 bridge is not configured on this server (MT5_BRIDGE_URL / MT5_BRIDGE_API_KEY).':
    'لم يُضبط جسر MT5 على هذا الخادم (MT5_BRIDGE_URL / MT5_BRIDGE_API_KEY).',
  'MT5 bridge returned {1} for {2} {3}: {4}': 'أعاد جسر MT5 الرمز {1} للطلب {2} {3}: {4}',
  'MT5 bridge timed out after {1}ms on {2} {3}. Nothing was changed.':
    'انتهت مهلة جسر MT5 بعد {1}ms للطلب {2} {3}. لم يتغير شيء.',
  'MT5 bridge timed out after {1}ms on {2} {3}. If this was a balance operation its outcome is UNKNOWN — reconcile against the MT5 deal history before retrying, and reuse the SAME idempotency key when you do.':
    'انتهت مهلة جسر MT5 بعد {1}ms للطلب {2} {3}. إن كانت عملية رصيد فنتيجتها غير معروفة — طابقها مع سجل صفقات MT5 قبل إعادة المحاولة.',
  'MT5 bridge unreachable for {1} {2}: {3}': 'تعذّر الوصول إلى جسر MT5 للطلب {1} {2}: {3}',
  'MT5 is temporarily unavailable ({1} {2}). Nothing was changed; try again in a few seconds.':
    'خدمة MT5 غير متاحة مؤقتًا ({1} {2}). لم يتغير شيء؛ يُرجى المحاولة مرة أخرى بعد بضع ثوانٍ.',
  'Demo accounts are not available online yet. Please contact support.':
    'الحسابات التجريبية غير متاحة عبر الإنترنت بعد. يُرجى التواصل مع الدعم.',
  'Opening a live account online is not available yet. Please contact support.':
    'فتح حساب حقيقي عبر الإنترنت غير متاح بعد. يُرجى التواصل مع الدعم.',
  'That account type is not available. Choose one from the list.':
    'نوع الحساب هذا غير متاح. اختر نوعاً من القائمة.',
  'That leverage is not available. Choose one from the list.':
    'الرافعة المالية هذه غير متاحة. اختر رافعة من القائمة.',
  'No open position with that id.': 'لا توجد صفقة مفتوحة بهذا المعرّف.',
  'That trading account belongs to a different client.': 'حساب التداول هذا يخص عميلاً آخر.',
  'Your identity must be verified before you can open a live account. You can open a demo account now and verify later.':
    'يجب التحقق من هويتك قبل أن تتمكن من فتح حساب حقيقي. يمكنك فتح حساب تجريبي الآن والتحقق لاحقاً.',
  'The start of the range must not be after its end.': 'يجب ألا تكون بداية الفترة بعد نهايتها.',
  'A history window may cover at most 31 days. Ask for a shorter range — a wider one is returned whole or not at all, and a whole one is more than a single response can carry for an actively traded account.':
    'يمكن أن تغطي فترة السجل 31 يوماً كحد أقصى. اختر فترة أقصر.',
  'The trading server could not be reached.': 'تعذّر الوصول إلى خادم التداول.',
  'We could not read this account from the trading server just now. Please try again.':
    'تعذّرت قراءة هذا الحساب من خادم التداول حالياً. يُرجى المحاولة مرة أخرى.',

  // ── wallet ───────────────────────────────────────────────────────────────────
  'currency must be a currency code, e.g. EUR.': 'يجب أن تكون العملة رمز عملة، مثل EUR.',
  'Wallet not found.': 'المحفظة غير موجودة.',
  'from and to must be YYYY-MM-DD dates.': 'يجب أن يكون تاريخا البداية والنهاية بصيغة YYYY-MM-DD.',
  'from and to must be real dates.': 'يجب أن يكون تاريخا البداية والنهاية تاريخين صحيحين.',
  'from must not be after to.': 'يجب ألا يكون تاريخ البداية بعد تاريخ النهاية.',
  'A statement covers at most {1} days.': 'يغطي كشف الحساب {1} يوماً كحد أقصى.',
  'A ledger entry must move a non-zero amount.': 'يجب أن يحرّك القيد مبلغاً غير صفري.',
  'Insufficient balance: the wallet holds {1}, and this needs {2}.':
    'الرصيد غير كافٍ: تحتوي المحفظة على {1}، وتتطلب هذه العملية {2}.',
  'Hold amount must be positive.': 'يجب أن يكون المبلغ المحجوز موجباً.',
  'Insufficient available balance: {1} {2} available, {3} requested.':
    'الرصيد المتاح غير كافٍ: المتاح {1} {2}، والمطلوب {3}.',
  // The desk's hand withdrawal from a wallet (7 Oct 2026).
  'Insufficient available balance: the wallet has {1} available, and this needs {2}.':
    'الرصيد المتاح غير كافٍ: المتاح في المحفظة {1}، وتتطلب هذه العملية {2}.',
  'Release amount must be positive.': 'يجب أن يكون المبلغ المُفرج عنه موجباً.',
  '{1} is not a currency this platform offers.': '{1} ليست عملة تقدمها هذه المنصة.',
  'This wallet holds {1} {2}. Move the balance out before closing it.':
    'تحتوي هذه المحفظة على {1} {2}. انقل الرصيد قبل إغلاقها.',
  'This wallet has {1} {2} on hold against a pending transfer. It cannot be closed until that settles.':
    'في هذه المحفظة {1} {2} محجوزة لتحويل قيد الانتظار. لا يمكن إغلاقها حتى تتم تسويته.',
  'This wallet has {1} historical record(s) against it and cannot be deleted. A wallet is the anchor its ledger entries point at; closing it would orphan them.':
    'لهذه المحفظة سجلات سابقة (عددها {1}) ولا يمكن حذفها.',
  'Wallet {1} not found.': 'المحفظة {1} غير موجودة.',

  // ── reasons the SYSTEM writes onto a client's movement (stored, then shown) ──
  'The payment provider could not complete this withdrawal.':
    'تعذّر على مزوّد الدفع إتمام عملية السحب هذه.',
  'This deposit was closed after a check and nothing was credited. If you sent money for it, contact support with your reference.':
    'أُغلق هذا الإيداع بعد التحقق ولم يُضَف أي مبلغ. إذا كنت قد أرسلت أموالاً له، فتواصل مع الدعم واذكر المرجع.',
  'The payment link expired before the payment arrived.':
    'انتهت صلاحية رابط الدفع قبل وصول الدفعة.',
  'The payment could not be started.': 'تعذّر بدء عملية الدفع.',
  'The trading account has no MT5 login.': 'لا يملك حساب التداول رقم دخول إلى MT5.',
  'The trading platform refused this transfer.': 'رفضت منصة التداول هذا التحويل.',
  // ── The portal assistant (0187) ──────────────────────────────────────────────
  'The assistant is not available right now.': 'المساعد غير متاح حالياً.',
  'Verify your identity to use the assistant.': 'تحقّق من هويتك لاستخدام المساعد.',
  'You are asking too quickly. Wait a moment and try again.':
    'أنت ترسل الأسئلة بسرعة كبيرة. انتظر قليلاً ثم حاول مجدداً.',
  'You have reached your daily question limit. It resets at midnight UTC.':
    'لقد بلغت الحد اليومي للأسئلة. يُعاد ضبطه عند منتصف الليل بتوقيت UTC.',
  'The assistant has reached its limit for today. Please try again tomorrow.':
    'بلغ المساعد حدّه لهذا اليوم. يُرجى المحاولة مجدداً غداً.',
  'An answer is already being written. Wait for it to finish.':
    'هناك إجابة قيد الكتابة. انتظر حتى تكتمل.',
  'Conversation not found.': 'لم يتم العثور على المحادثة.',
  'Message not found.': 'لم يتم العثور على الرسالة.',
  'There is no answer to regenerate.': 'لا توجد إجابة لإعادة إنشائها.',
  'This conversation is full. Start a new chat.': 'هذه المحادثة ممتلئة. ابدأ محادثة جديدة.',
  'This question was already received.': 'تم استلام هذا السؤال مسبقاً.',
  'Somebody handled this task already — it is in History.':
    'تولّى أحد الزملاء هذه المهمة بالفعل، وهي الآن في السجل.',
  'This task ends only when its item is handled — open it and decide it there.':
    'لا تنتهي هذه المهمة إلا بمعالجة عنصرها. افتحه واتخذ القرار هناك.',
  'Write a question of up to 2000 characters.': 'اكتب سؤالاً لا يتجاوز 2000 حرف.',
  // ── Added 6 Oct 2026: period filters, the two-level partner tree (0197), sign-up links, pay-to ──
  'from must be a date or a date-time with its offset':
    'يجب أن تكون قيمة «من» تاريخًا، أو تاريخًا ووقتًا مع فرق التوقيت.',
  'to must be a date or a date-time with its offset':
    'يجب أن تكون قيمة «إلى» تاريخًا، أو تاريخًا ووقتًا مع فرق التوقيت.',
  '{1} must be a date (YYYY-MM-DD) or a date-time with its offset (2026-10-06T08:30:00+03:00)':
    'يجب أن تكون قيمة {1} تاريخًا (YYYY-MM-DD) أو تاريخًا ووقتًا مع فرق التوقيت (2026-10-06T08:30:00+03:00).',
  '{1} must be after {2}': 'يجب أن تكون قيمة {1} بعد {2}.',
  'Commission share must be a percentage from 0 to 100, at most 4 decimals.':
    'يجب أن تكون حصة العمولة نسبة مئوية من 0 إلى 100، بأربع منازل عشرية كحد أقصى.',
  'Rebate share must be a percentage from 0 to 100, at most 4 decimals.':
    'يجب أن تكون حصة الاسترداد نسبة مئوية من 0 إلى 100، بأربع منازل عشرية كحد أقصى.',
  'The chosen parent is a sub-partner, and a sub-partner cannot have partners beneath them — the tree has two levels. Approve this application under a main partner, or with no parent.':
    'الشريك الأعلى المختار شريك فرعي، ولا يمكن أن يكون تحت الشريك الفرعي شركاء، فللشجرة مستويان فقط. وافق على هذا الطلب تحت شريك رئيسي، أو من دون شريك أعلى.',
  'This partner has no parent, so they are a main partner (level 1). To make them a sub-partner, reassign them under a main partner.':
    'ليس لهذا الشريك شريك أعلى، لذا فهو شريك رئيسي (المستوى 1). لجعله شريكًا فرعيًا، انقله تحت شريك رئيسي.',
  'This partner sits under another partner, so they are a sub-partner (level 2). To make them a main partner, remove their parent.':
    'هذا الشريك تحت شريك آخر، لذا فهو شريك فرعي (المستوى 2). لجعله شريكًا رئيسيًا، أزل شريكه الأعلى.',
  'Only a sub-partner has their own commission and rebate. A main partner takes the whole commission on their own clients and the rest on their sub-partners’.':
    'وحده الشريك الفرعي له عمولة واسترداد خاصان به. يأخذ الشريك الرئيسي كامل العمولة على عملائه، والباقي على عملاء شركائه الفرعيين.',
  'That partner is a sub-partner, and a sub-partner cannot have partners beneath them. Choose a main partner (level 1).':
    'هذا الشريك شريك فرعي، ولا يمكن أن يكون تحت الشريك الفرعي شركاء. اختر شريكًا رئيسيًا (المستوى 1).',
  'This partner has sub-partners of their own, so they cannot become a sub-partner. Move their sub-partners first.':
    'لهذا الشريك شركاء فرعيون، لذا لا يمكن أن يصبح شريكًا فرعيًا. انقل شركاءه الفرعيين أولًا.',
  'The partner tree has {1} levels: main partners (level 1) and their sub-partners (level 2). A deeper level cannot be added.':
    'عدد مستويات شجرة الشركاء {1}: الشركاء الرئيسيون (المستوى 1) وشركاؤهم الفرعيون (المستوى 2). لا يمكن إضافة مستوى أعمق.',
  'This phone number is already used by another OxShare account.':
    'رقم الهاتف هذا مستخدم بالفعل في حساب OxShare آخر.',
  'Another administrator already uses this link. Choose another word.':
    'يستخدم مسؤول آخر هذا الرابط بالفعل. اختر كلمة أخرى.',
  'A method can show at most {1} details.': 'يمكن أن تعرض الطريقة {1} تفاصيل كحد أقصى.',
  'Enter what the client should see.': 'أدخل ما يجب أن يراه العميل.',
  'Keep the value to {1} characters, on one line.': 'اجعل القيمة في حدود {1} حرفًا وعلى سطر واحد.',
  // The MT5 login lookup refuses a login owned outside the reader's territory (7 Oct 2026).
  'Login {1} already belongs to a client outside your territory.':
    'رقم الدخول {1} يخص عميلًا خارج نطاقك.',
};
