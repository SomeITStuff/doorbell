# Домофон ML-20IP — развёртывание

Своя замена инфраструктуры Slinex: Telegram-бот → мини-апп → видео/звук/микрофон/реле.
Без VPS, без VPN на телефоне.

## Что где лежит

| Компонент | Где | Что делает |
|---|---|---|
| `box/` | коробка у двери (Linux, Pi/мини-ПК) | go2rtc (видео), мост сигналинга, бот, прокси, слушатель панели |
| `miniapp/` | GitHub Pages | клиент: видео, звук, микрофон, кнопка двери |
| Firebase RTDB | облако (free) | сигналинг (обмен SDP/ICE) |
| Telegram | облако | уведомление о звонке, открытие мини-аппа |

## 1. Коробка

Требования: Linux, доступ в интернет, в той же сети что панель, `python3`, `aiohttp`, `aiortc`.

```bash
# 1) файлы: box/ + tools/ (go2rtc, ffmpeg) рядом
# 2) секреты
cp box/.env.example box/.env 2>/dev/null || nano box/.env   # заполнить
chmod 600 box/.env

# 3) автозапуск
sudo bash box/systemd/install.sh
```

Содержимое `.env`:

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `CHAT_ID` | твой Telegram ID — владелец (админ) |
| `ALLOWED_CHAT_IDS` | начальный список ID через запятую (используется только при первом запуске, дальше — `users.json`) |
| `BOT_USERNAME` | имя бота без @ |
| `MINIAPP_URL` | `https://<логин>.github.io/doorbell` |
| `RTDB_URL`, `RTDB_SECRET` | Firebase: URL базы и Database secret |
| `RING_KEY` | любой секрет для `/ring` |
| `STREAM` | `panel` (или `cam` для демо) |
| `PANEL_IP`, `PANEL_USER`, `PANEL_PASS`, `PANEL_CGI_DOOR` | панель |

## 2. Панель

1. **Включить RTSP** (один раз, через telnet `root/opencode`):
   ```sh
   vconfig set rtspsvr:enable 1        # или правка /mnt/config/ipcamera/config_user.ini
   ```
   Проверка: `rtsp://Admin:<пароль>@<панель>:554/0` (VLC).
   В `go2rtc.yaml` раскомментировать `panel:` и в `.env` поставить `STREAM=panel`.

2. **Маршрут кнопки вызова на коробку** (чтобы кнопка звонила в Telegram):
   ```sh
   sh panel_route.sh <IP_коробки>
   ```
   Для сохранения после перезагрузки — добавить эту строку в `/etc/init.d/S10mpp`
   (и записать в JFFS2 тем же способом, что мы патчили прошивку).

3. **Реле (открыть дверь)** — найдено в веб-интерфейсе панели, двухшаговая команда:
   ```
   GET /cgi-bin/hi3510/getunlockpwd.cgi?&-time=<ms>   # получить пароль
   GET /cgi-bin/hi3510/doorUnlock.cgi?&-time=<ms>     # открыть дверь
   ```
   Мост делает это сам (нужны `PANEL_IP`, `PANEL_USER`, `PANEL_PASS` в `.env`).

## 3. Telegram

1. @BotFather → `/newbot` → токен в `.env`.
2. BotFather → *Bot Settings → Configure Mini App* → URL = `MINIAPP_URL`, режим = **compact**
   (на Android compact сейчас не работает из-за бага клиента — окно откроется на всю высоту).
3. Владелец — `CHAT_ID`. Остальные пользователи добавляются командами бота (см. ниже).
   `ALLOWED_CHAT_IDS` используется только при первом запуске: из него и `CHAT_ID` создаётся `box/users.json`.

### Пользователи и роли

| Команда | Кто | Что делает |
|---|---|---|
| `/start`, `/id` | все | показать свой ID и роль |
| `/link` | все | постоянная ссылка на мини-апп (для закладки) |
| `/call` | все | тестовый звонок |
| `/users` | админ | список пользователей |
| `/add <id> [view\|door] [имя]` | админ | добавить пользователя |
| `/role <id> <view\|door>` | админ | сменить роль |
| `/del <id>` | админ | удалить и отозвать токены |

Роли: **view** — смотреть, слушать, говорить; **door** — плюс открывать дверь.

Как добавить: человек открывает бота и нажимает Start → бот отвечает его ID →
админ пишет `/add <id> view Имя`. Звонок при нажатии кнопки панели уходит **всем** пользователям.

Хранилище (в git не попадает): `box/users.json` — роли, `box/tokens.json` — токены доступа
(временные на звонок 24 ч, постоянные по `/link`).

## 4. Firebase

1. console.firebase.google.com → Realtime Database (регион, напр. europe-west1).
2. Rules — только комнаты, без перечисления:
   ```json
   { "rules": { ".read": false, ".write": false,
     "rooms": { "$room": { ".read": true, ".write": true } } } }
   ```
3. Project settings → Service accounts → **Database secrets** → в `.env` (`RTDB_SECRET`).

## 5. Мини-апп (GitHub Pages)

Файлы `miniapp/` (index.html, app.js, style.css, version.json) — в репозиторий, включить Pages.
После правок — поднять `build` в `index.html` и `version.json` (авто-обновление у клиентов).

## Проверка

```bash
curl -s --noproxy '*' 'http://127.0.0.1:1984/api/streams?src=cam'   # поток жив
curl -s --noproxy '*' 'http://127.0.0.1:8090/ring?key=<RING_KEY>'   # тестовый звонок
```
