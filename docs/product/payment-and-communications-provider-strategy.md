# Vow: стратегия платёжных и коммуникационных провайдеров

Дата: 2026-11-17  
Статус: предварительная рекомендация, не одобрение провайдеров и не разрешение на Production.

## Исходные условия
- Vow — мобильное приложение Android/iOS для серьёзных отношений; публичный web frontend не планируется.
- Юрисдикция проекта: Грузия.
- Текущий статус владельца: физическое лицо; компания не зарегистрирована. Не предполагать наличие LLC или статуса individual entrepreneur.
- До merchant onboarding выяснить, принимает ли каждый провайдер физлицо — резидента Грузии, грузинского individual entrepreneur или требует LLC, а также какие банковские счета и документы нужны.
- Stripe исключён.
- Paddle не использовать для dating при действующих ограничениях его AUP; не считать доступным без официального изменения политики и письменного разрешения.
- Production, реальные списания, возвраты и provider-side mutations запрещены до отдельного разрешения.
- Рекламные тарифы и условия провайдеров не считать подтверждёнными только по маркетинговым страницам.

## 1. Подписки и цифровые функции
- Android: Google Play Billing там, где это требуют правила Google.
- iOS: Apple StoreKit / In-App Purchase там, где этого требуют правила Apple.
- Lady Premium, цифровые подарки, boost/super-likes и отключение рекламы — цифровые товары; не проектировать скрытый обход магазинных правил.
- Внешние платежи внутри приложений возможны только в конкретных странах и программах, после регистрации и выполнения условий соответствующего магазина.
- Комиссии Google Play зависят от страны, программы и даты. Не фиксировать одну глобальную ставку. Перед финансовым моделированием проверить действующие первоисточники отдельно для каждой страны.
- Реальные подарки с доставкой, бронирование кафе и другие физические услуги могут иметь отдельный внешний платёжный сценарий, если правила магазинов это допускают и юридически определены продавец, исполнитель, возвраты и ответственность.

Цифровые и физические SKU должны быть разделены. Нельзя выдавать цифровые entitlement на основании события физического заказа и наоборот.

## 2. Внешний эквайринг — shortlist
### Приоритет 1: Segpay
Первый кандидат на underwriting. Запросить письменное подтверждение допустимости Vow как serious relationship / marriage-oriented dating без adult-контента, с верификацией пользователей, подписками и отдельными сценариями физических подарков.
https://segpay.com/verticals/high-risk/

### Приоритет 2: Centrobill
Параллельный запрос по dating, recurring billing, физическим подаркам и международным выплатам.
https://2026.centrobill.com/high-risk-payment-processing/dating-industry/

### Приоритет 3: Payment Nerds — условный
Рассматривать только после проверки требований к грузинской юрисдикции, владельцу, банковскому счёту и конкретному acquiring bank. Посредник/шлюз не гарантирует одобрения merchant account.
https://paymentnerds.com/faq/

### Не закладывать в основу без письменного решения
- Authorize.net и NMI: шлюз не гарантирует одобрения эквайером dating-бизнеса.
- Adyen: отраслевые ограничения могут исключать или ограничивать dating/matchmaking; сначала нужна письменная классификация Vow.
- NOWPayments: криптовалюта не входит в MVP и добавляет комплаенс- и потребительские риски.
- Stripe: запрещён решением владельца.
- Paddle: не использовать для dating при действующих ограничениях.

### Вопросы эквайеру
1. Принимаете ли dating apps для серьёзных отношений/брака без adult-контента?
2. Принимаете ли проект до запуска и без оборота?
3. Заключаете ли договор с физлицом — резидентом Грузии? Если нет, подходит ли грузинский individual entrepreneur или требуется LLC?
4. Какие документы нужны владельцу, бизнесу и бенефициарам?
5. Какой банк-эквайер обслуживает merchant account, какой MCC и descriptor?
6. Какие страны покупателей и валюты поддерживаются?
7. Поддерживаются ли recurring billing, retries, card updater и self-service cancellation?
8. Каковы processing/fixed fees, monthly minimum, setup fee, rolling reserve, payout delay, refund и chargeback fees?
9. Каковы fraud/chargeback thresholds, правила hold/freeze и сроки разблокировки?
10. Разрешены ли физические подарки, доставка и partner services? Кто merchant of record?
11. Какие webhooks, idempotency, reconciliation, dispute API и sandbox доступны?
12. Подтвердите допустимость модели Vow письменно до интеграции.

## 3. OTP и телефонная верификация
### Приоритет 1: Prelude
Первый кандидат благодаря опубликованному кейсу dating-приложения Nymph. Это релевантный отраслевой пример, но не гарантия одобрения Vow или покрытия всех стран.
https://prelude.so/blog/case-study-nymph

Запросить письменное dating approval, покрытие стран/операторов, полный тариф SMS по странам, sender ID requirements, SLA, delivery reports, retries, fraud controls, DPA, retention, subprocessors, sandbox и тестовые номера.

### Резерв: DIDWW
Технический резерв после письменного подтверждения допустимости dating use case, Грузии и целевых стран.
https://www.didww.com/

### YCloud / WhatsApp
Не обходить политику WhatsApp через общие номера или неофициальные схемы. Использовать только после письменного подтверждения допустимости dating use case по правилам YCloud и WhatsApp.

## 4. Push
- Android: Firebase Cloud Messaging (FCM).
- iOS: APNs; FCM может быть единым серверным интерфейсом, но iOS всё равно требует корректной APNs-конфигурации.
- Не помещать в push текст переписки, документы, биометрические результаты, результаты проверки личности или приватные сведения другого пользователя.
- Предусмотреть категории, настройки пользователя, quiet hours, token rotation, invalid-token cleanup и аудит.

## 5. Backend-архитектура
Сохранить провайдер-независимый слой:
- Billing Provider Adapter — общий интерфейс Google Play, Apple и внешних провайдеров.
- Store Receipt Validator — серверная проверка магазинных транзакций.
- Entitlement Service — единый источник прав Premium и цифровых покупок.
- Payment Ledger — история денежных операций.
- Provider Identity Ledger — связь заказа с точной попыткой и идентификатором провайдера.
- Webhook Inbox — durable inbox, проверка подписи до enqueue, дедупликация, lease/fencing, retry и dead-letter.
- Reconciliation Worker — сверка состояний; неопределённость не должна запускать повторное создание платежа.
- Refund & Dispute Service — отдельный контролируемый процесс возвратов и споров.
- OTP Router — маршрутизация OTP, rate limits, abuse controls и fallback только на одобренные каналы.
- Push Dispatcher — единый интерфейс FCM/APNs.

Секреты хранить только на сервере в secret store; не включать их в мобильные приложения, репозиторий, логи или crash reports.

## 6. Грузинский юридический onboarding
Пока владелец — физическое лицо. До договоров получить консультацию грузинского бухгалтера/юриста о допустимости деятельности физлица, необходимости individual entrepreneur или LLC, налогах/VAT, consumer terms, privacy и трансграничных выплатах. Параллельно запросить у каждого провайдера, какие из этих форм он принимает. Не регистрировать компанию и не открывать счета автоматически — сначала сравнить требования и расходы.

## 7. Ограничения
- Не включать Production и не проводить реальные платежные операции.
- Не подключать провайдера до письменного approval и проверки договора/AUP.
- Не считать физлицо автоматически подходящим merchant entity.
- Не регистрировать компанию от имени владельца без отдельного решения.
- Не добавлять Stripe; не использовать Paddle для dating.
- Не менять VPS и существующие сайты.
- Не создавать публичный web frontend Vow.

## Источники для первичной перепроверки
- Google Play Payments policy: https://support.google.com/googleplay/android-developer/answer/9858738
- Google Play developer policies: https://support.google.com/googleplay/android-developer/
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Segpay: https://segpay.com/verticals/high-risk/
- Centrobill: https://2026.centrobill.com/high-risk-payment-processing/dating-industry/
- Payment Nerds: https://paymentnerds.com/faq/
- Prelude Nymph case study: https://prelude.so/blog/case-study-nymph
- DIDWW: https://www.didww.com/
- FCM: https://firebase.google.com/docs/cloud-messaging
- APNs: https://developer.apple.com/documentation/usernotifications

Все сведения о комиссиях, странах, отраслевых политиках и юридических требованиях динамичны. Перед коммерческим решением перепроверить первоисточники и получить письменные ответы.
