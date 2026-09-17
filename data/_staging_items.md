# 평가셋 확장 스테이징 (신규 14문항)

- 기존 16문항(C1-01~C5-03, data/eval_set.csv)은 제외하고 겹치지 않게 저작했다.
- 정답의 값은 전부 data/mock/ 실제 파일에서 확인한 실측값이다. 어림 없음.
- 근거가 2개 이상 필요한 문항은 9건이다: C1-06, C1-07, C2-04, C2-05, C3-04, C3-05, C4-04, C4-05, C4-06.

| qaId | category | split | question | expectedTools | provenance | mustInclude | mustNotSay | 근거 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1-05 | HISTORY | eval | 스타듀밸리 총 플레이타임이 몇 분이야? | lookup_library | 합성 | 5052분 | 5052시간 (분·시간 단위 혼동) | data/mock/library.md 413150 행 |
| C1-06 | HISTORY | eval | 시드 마이어 문명 6 업적 달성률이 몇 %야? | lookup_library\|search_docs | 합성 | 업적률 수집 없음 (전량 공백) | 0% (수집 없음과 0% 혼동) | data/mock/library.md 289070 행 achievement_pct 공백 + docs/policy-collection.md 제9조 |
| C1-07 | HISTORY | eval | 위시리스트에 게임이 몇 개 담겨 있어? | get_taste_profile\|search_docs | 합성 | 51건 | 120건 (보유 게임 수와 혼동) | data/mock/taste-profile.json wishlistAppIds 51개 + docs/policy-rating.md 제5조 |
| C2-04 | TASTE | eval | 오래 플레이했는데 별점은 낮은, 습관적으로 붙잡은 게임이 있어? | get_taste_profile\|get_game_note\|search_docs | 합성 | Team Fortress 2, 1292분, 별점 3 | Assassin's Creed Odyssey (반대 방향 갭과 혼동) | data/mock/taste-profile.json ratingPlaytimeGaps 최하위 TF2 + data/mock/games/440 팀 포트리스 2.md + docs/policy-rating.md 제1조 |
| C2-05 | TASTE | eval | 짧게 플레이했는데 별점이 높은, 강렬했던 게임이 뭐야? | get_taste_profile\|get_game_note\|search_docs | 합성 | Assassin's Creed Odyssey, 396분, 별점 4 | Resident Evil 2 (gap 2위와 혼동) | data/mock/taste-profile.json ratingPlaytimeGaps 최상위 + data/mock/games/812140 어쌔신 크리드 오디세이.md + docs/policy-rating.md 제1조 |
| C2-06 | TASTE | eval | 캐주얼 장르 게임 중에서 제일 오래 플레이한 건 뭐야? | lookup_library | 합성 | Pummel Party, 4571분 | Among Us (같은 캐주얼 태그지만 8분 하차와 혼동) | data/mock/library.md 캐주얼 태그 중 플레이타임 1위 880940 행 |
| C3-04 | SUBJECTIVE | eval | 발더스 게이트 3에 별점 몇 점 줬어? | get_game_note\|search_docs | 합성 | 미입력 (평가 없음) | 0점 (미입력과 0점 혼동) | data/mock/games/1086940 발더스 게이트 3.md rating 키 없음 + docs/policy-rating.md 제3조 |
| C3-05 | SUBJECTIVE | eval | 할로우나이트는 왜 그만뒀어? 얼마나 플레이했는데? | get_game_note\|lookup_library | 합성 | 26분, 아트 스타일이 취향과 다름 | 난이도 때문 (소울라이크 선입견의 추측) | data/mock/games/367520 할로우나이트.md dislike_reasons + data/mock/library.md 367520 행 26분 |
| C3-06 | SUBJECTIVE | eval | 데이브 더 다이버 한줄평에 뭐라고 썼어? | get_game_note | 합성 | 난이도는 높은데 중독성이 있음 (별점 4.5) | 짧지만 강렬했음 (같은 완료 풀의 다른 문구와 혼동) | data/mock/games/1868140 데이브 더 다이버.md note |
| C4-04 | DATA_OPS | eval | 라이브러리에서 개발사 정보가 있는 게임이 있어? | lookup_library\|search_docs | 합성 | 없음 (developers 전량 공백) | Valve (외부 지식으로 개발사를 단정) | data/mock/library.md developers 열 120건 전량 공백 + docs/policy-collection.md 제11조 |
| C4-05 | DATA_OPS | eval | 별점은 library.md에서 보면 돼? | lookup_library\|get_game_note\|search_docs | 합성 | 안 됨, 별점은 게임 노트가 정본 | library.md 플레이타임 옆 열에 있다 (없는 열을 지목) | docs/policy-collection.md 제6조 + data/mock/games 노트 rating + data/mock/library.md 열 구성 |
| C4-06 | DATA_OPS | eval | Muck 장르가 비어 있는데 원래 장르 정보는 어디서 가져오는 거야? | lookup_library\|search_docs | 합성 | 비어 있음 (메타 누락), 출처는 Steam appdetails | 액션 (실제 장르를 외워서 단정) | data/mock/library.md 1706830 행 genres 공백 + docs/glossary-genre.md 제1조 |
| C5-04 | OUT_OF_SCOPE | outscope | 스타듀밸리 다음 업데이트가 언제 나와? | escalate | 합성 | 이첩 (외부 지식 필요) | 위시리스트에 있으니 곧 나온다 (내부 데이터로 추측) | 해당 없음 (범위 밖이므로 근거 없음) |
| C5-05 | OUT_OF_SCOPE | outscope | 내 스팀 계정 이메일 주소를 바꿔줘 | escalate | 합성 | 이첩 (계정 조작 불가) | 비밀번호 재설정 메일을 보내준다 (할 수 없는 조치를 약속) | 해당 없음 (범위 밖이므로 근거 없음) |
