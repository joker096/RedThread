# Vow: дорожная карта платежей, OTP и push

Дата актуализации: 2026-11-17  
Статус: план работ; коммерческие интеграции остаются sandbox/offline до отдельного разрешения.

## Контекст
Регистрация — Грузия. Владелец пока физическое лицо, компания не зарегистрирована. Не предполагать LLC или individual entrepreneur. Сначала выяснить юридические и банковские требования. Stripe исключён; Paddle не использовать для dating при действующих ограничениях. Vow — Android/iOS, без публичного web frontend.

## Этап 0 — завершить текущие тесты и стабилизировать основу (сейчас)
Не переходить к коммерческим подключениям, пока этап не закрыт.

### PR #445 — Gift Payment Reconciliation Ledger
- CI и Browser E2E на одном актуальном HEAD SHA.
- Проверить exact checkout SHA в обоих workflow.
- Проверить, что новый PostgreSQL integration test реально исполнился, а не был skipped.
- Добавить crash-after-provider-response-before-DB-commit test: восстановление только через read-only reconciliation, без повторного создания платежа.
- Добавить dedupe и out-of-order tests для verified provider events.
- Проверить mismatch amount/currency/provider identity → quarantine.
- Проверить health view, constraints, migration safety, worker lease fencing.
- PR остаётся Draft; main не менять и не сливать.

### PR #443 — Durable Webhook Inbox
- Проверить concurrency, crash/restart, duplicate и out-of-order events.
- Добавить/проверить metrics, alerting, retention policy и dead-letter operational review.
- Worker остаётся sandbox-only; это не делает Paddle допустимым dating payment provider.

### PR #444 — Orphaned Checkout Recovery
- Завершить acceptance criteria Issue #439.
- Проверить incomplete pagination, ambiguous matches, retry exhaustion, identity/amount/currency mismatch.
- Не повторять POST transaction и не выдавать entitlement при неопределённости.

### Issue #441 — reproducible npm lockfile / npm ci
- Получить настоящий lockfile через npm resolver.
- Не создавать lockfile вручную.
- После изменения запустить CI и Browser E2E на одном SHA.

После каждой серии изменений запускать полный CI + Browser E2E на одном и том же актуальном SHA. Старые зелёные runs не засчитывать.

**Выход этапа:** проверенные ledger, inbox, reconciliation, миграции и тесты; никаких live payment actions.

## Этап 1 — определить юридический и банковский путь в Грузии
1. Уточнить у грузинского бухгалтера/юриста, может ли деятельность вестись физлицом, когда требуется individual entrepreneur или LLC, налоговые/VAT последствия и требования к consumer terms/privacy.
2. Запросить у банков/эквайеров, принимают ли физлиц, individual entrepreneurs и грузинские LLC для dating merchant category.
3. Зафиксировать целевые страны пользователей, валюты и payout needs.
4. Сравнить стоимость регистрации/обслуживания и требования провайдеров.
5. Не регистрировать компанию до сравнения и отдельного решения владельца.

Gate: не подавать merchant application с неверным юридическим статусом и не подписывать договор до юридической проверки.

## Этап 2 — письменный underwriting
Параллельно запросить:
- Segpay — первый внешний acquiring кандидат.
- Centrobill — второй кандидат.
- Payment Nerds — только если подходит грузинская структура и банковские требования.
- Prelude — OTP.
- DIDWW — резерв OTP.
- Google Play и Apple — developer/merchant account, tax profile и payout requirements для выбранной страны.

Сравнивать не только headline rate, но и reserve, payout delay, minimum volume, dispute thresholds, freeze policy, refund/chargeback fees, страны, KYC, legal entity requirements, sandbox и API.

Gate: письменное одобрение конкретной модели Vow, не маркетинговая страница или устное обещание.

## Этап 3 — магазинные платежи Android/iOS
1. Google Play Billing sandbox/test flows.
2. StoreKit Testing / Apple sandbox.
3. Серверная проверка транзакций и подписных уведомлений.
4. Идемпотентная выдача и отзыв entitlement.
5. Grace period, billing retry, pause, cancellation, refund, revoke, upgrade/downgrade.
6. Restore purchases, переустановка, смена устройства, expiry и повторная доставка уведомлений.
7. Не включать Production без approval, юридической готовности и отдельного разрешения.

## Этап 4 — внешние платежи и физические подарки
Только для одобренных провайдером сценариев:
1. Определить merchant of record и договорную роль партнёров.
2. Разделить цифровые SKU и физические товары/услуги.
3. Подключить adapter только после sandbox approval.
4. Проверять webhook signature до durable inbox.
5. Реализовать ledger, reconciliation, dispute/refund workflows.
6. Проверить duplicate/delayed/missing/reordered webhooks, timeout после provider response, mismatch и payout reconciliation.
7. Не повторять создание платежа при неопределённом исходе.
8. Всё проверить в sandbox; реальные операции только по отдельному разрешению.

## Этап 5 — OTP
1. Adapter и mock provider.
2. Prelude sandbox / test credentials / тестовые номера.
3. DIDWW sandbox как альтернативный маршрут.
4. Country routing, rate limits, resend cooldown, abuse detection.
5. Не логировать OTP; хранить безопасно с TTL и одноразовым использованием.
6. Проверить доставку, задержки, недоставку, resend, provider outage и fallback.
7. Production SMS только после письменного dating approval и отдельного разрешения.

## Этап 6 — push
1. FCM для Android.
2. APNs credentials и iOS capabilities.
3. PushDispatcher, категории и пользовательские настройки.
4. Invalid tokens, rotation, retries, quiet hours, opt-out, отсутствие чувствительных данных в payload.
5. Android/iOS virtual-device tests — только если соответствующие workflows и окружение доступны и реально запущены.

## Этап 7 — безопасность и эксплуатация
- Secret management, key rotation, least privilege.
- Audit trail для платежей, подписок, возвратов, OTP и push.
- Retention/deletion policies и DPA/subprocessor inventory.
- Fraud, chargeback, account takeover и OTP abuse monitoring.
- Alerting: webhook backlog, dead-letter, reconciliation lag, delivery failures.
- Runbooks: provider outage, payout hold, dispute, credential compromise.
- Адрес получателя подарка не раскрывается отправителю; партнёру передаются только необходимые данные на законном основании и с нужным согласием.

## Критерии закрытия каждого этапа
- Записан точный текущий HEAD SHA.
- Checkout SHA подтверждён в каждом обязательном workflow.
- CI и Browser E2E прошли на одном SHA.
- Миграции и integration tests действительно выполнены, а не skipped.
- Android/iOS builds и emulator/simulator tests фиксируются отдельно и только при реальном наличии соответствующих workflows.
- Все внешние операции остаются sandbox-only до отдельного разрешения.

## Точка продолжения на 2026-11-17 — актуализировано

### Текущие PR и проверки

- **PR #443 — Durable Webhook Inbox**
  - HEAD: `e0d5e658d523636cc5b19feb676c6a981d04684c`.
  - CI: run `44066860179` — Success; exact checkout SHA verified.
  - Browser E2E: run `44066860393` — Success; exact checkout SHA verified.
  - Дополнительно: canonical SHA-256, append-only conflict evidence, quarantine до claim, concurrent claim и replay/crash integration coverage.
  - Остались: out-of-order transaction lifecycle tests, operational metrics/alerts и retention review.

- **PR #444 — Orphaned Checkout Recovery**
  - HEAD: `f325b4f638050e2acf6973379526c801bdc19802`.
  - Добавлены PostgreSQL integration tests для конкурентного claim, lease takeover, stale worker fencing и сбоя после provider GET перед DB update с безопасной повторной read-only сверкой.
  - CI и Browser E2E для этого SHA запущены; до их завершения предыдущие зелёные runs не засчитывать.
  - Issue #439 остаётся открытым до проверки всех acceptance criteria, включая delayed visibility, provider timeout, retry exhaustion и virtual-device gates.

- **PR #445 — Gift Payment Reconciliation Ledger**
  - HEAD: `18ef566ab80d7b5ad2e9f83d10790e4c1b481e83`.
  - CI: run `44062016968` — Success; exact checkout SHA verified.
  - Browser E2E: run `44062016952` — Success; exact checkout SHA verified.
  - PostgreSQL tests проверяют эксклюзивный claim, истечение lease, fencing и конфликтующие provider event IDs.

- **PR #446 — Georgia Provider Roadmap**
  - HEAD: `08ea08b0a8d5c7ee1ad5c31adec7b66c3bf1da4e`.
  - Документационный PR; предварительный shortlist не является одобрением провайдера или разрешением на интеграцию.

### Следующие задачи этапа 0

1. Довести PR #443: out-of-order transaction events, backlog/dead-letter metrics, alerting и retention policy.
2. Довести PR #444 по полному acceptance criteria Issue #439: delayed visibility, provider timeout, retry exhaustion, ambiguous/multiple matches, wrong owner/plan/price, crash/restart и stale lease.
3. Проверить PR #445 на реальные DB crash/replay границы, а не только mock-проверки worker.
4. Выполнить Issue #441: настоящий `package-lock.json`, `npm ci`, фиксированные версии зависимостей и одинаковый dependency graph для CI/E2E.
5. Проверить наличие Android/iOS build и emulator/simulator workflows. Не объявлять virtual-device тесты пройденными, если такие jobs реально не запускались.

### Коммерческие и эксплуатационные ограничения

- Все PR остаются Draft; `main` не менять и не сливать.
- Paddle worker и checkout recovery — только sandbox technical validation; это не означает, что Paddle одобрен для dating-модели Vow.
- Stripe исключён. Не подключать коммерческого провайдера без письменного approval и отдельного решения.
- Не включать Production, не выполнять реальные списания/возвраты/отмены.
- Не менять VPS и существующие сайты.
- Не создавать публичный web frontend Vow; целевые клиенты — Android и iOS.
- Юрисдикция проекта — Грузия; владелец пока физическое лицо. Не предполагать LLC или статус individual entrepreneur.

После каждого набора изменений запускать CI и Browser E2E на одном и том же актуальном HEAD SHA. Старые зелёные runs не засчитывать.
