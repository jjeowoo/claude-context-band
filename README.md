# context-band

Claude 데스크톱 앱(Code 탭)과 Claude Code 터미널에서 **컨텍스트 사용량과 사용 한도를 입력창 바로 위에 항상 표시**하는 모드입니다.

> 컨텍스트 ━━─── 42% 사용 (84k / 200k) │ 세션 ━──── 5% 사용 (23분 후 재설정) │ 주간 ━━─── 22% 사용 (3일 2시간 후 재설정)

- 데스크톱 앱: 끝이 둥근 막대, 터미널: 글자 막대
- 세션(5시간) 한도와 주간 한도를 한 줄에 나란히, 항목 사이는 옅은 세로 구분선으로 표시 (좁으면 다음 줄로). 구독 계정에서 앱이 받은 수치가 있을 때만 나오며, 계정 전체 수치라 마지막으로 받은 값을 다른 세션과 공유합니다. 아직 응답을 받지 않은 새 세션에도 바로 나오고, 그 사이 재설정 시각이 지난 한도는 숨깁니다. 남은 시간은 1분마다 다시 그림
- 75% 이상 주황, 90% 이상 빨강 (한도 줄도 같음)
- 컨텍스트가 75%, 90%를 처음 넘을 때 알림 팝업 (컴팩트 후 다시 넘으면 다시 알림)
- 앱이 이미 가진 수치를 읽기만 하므로 **토큰/사용량을 추가로 쓰지 않습니다.** 알림도 대화 내용에 들어가지 않습니다.

## 설치 (Windows)

```
git clone https://github.com/jjeowoo/claude-context-band.git
cd claude-context-band
```

이 폴더에서 PowerShell로:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`~/.claude/settings.json`의 `env.CLAUDE_CODE_PLUGIN_DIRS`에 이 폴더 경로를 등록합니다 (기존 설정은 `settings.json.bak`으로 백업). 앱을 껐다 켜거나 새 세션을 열면 적용됩니다.

폴더를 옮겼다면 옮긴 위치에서 `install.ps1`을 다시 실행하세요.

## 제거

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 다른 설치 방법: 플러그인 마켓플레이스

터미널의 Claude Code 프롬프트에서:

```
/plugin install context-band --marketplace jjeowoo/claude-context-band
```

셸에서:

```
claude plugin install context-band --marketplace jjeowoo/claude-context-band
```

데스크톱 앱에서는 프롬프트 옆 + → Plugins → Add marketplace에 `jjeowoo/claude-context-band`를 넣은 뒤 Add plugin.

이 방법을 쓸 때는 `install.ps1`로 등록한 것과 겹치지 않도록 하나만 사용하세요.

## 개발

```
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: 본체
- `types/index.d.ts`: 상태 타입
- `tests/band.test.tsx`: 테스트
