begin;

do $$
declare
 dataset constant text := 'cad-design-ja-v1';
 author_id constant text := 'cad00000-0000-4000-8000-000000000001';
 reviewer_id constant text := 'cad00000-0000-4000-8000-000000000002';
 senior_id constant text := 'cad00000-0000-4000-8000-000000000003';
 it_id constant text := 'cad00000-0000-4000-8000-000000000004';
 target_project uuid;
 current_state public.project_states;
 actor record;
 source record;
 content jsonb;
 raw_record jsonb;
 card jsonb;
 snapshot jsonb;
 route jsonb;
 sorted_events jsonb;
 owner_id text;
 raw_id text;
 card_id text;
 core_id text;
 created_at timestamptz;
 batch_time timestamptz := now()-interval '1 day';
 added integer := 0;
begin
 select id into target_project from public.projects where is_default;
 if target_project is null then raise exception 'Initialize a default workspace before loading CAD demo data'; end if;
 insert into public.project_states(project_id) values(target_project) on conflict(project_id) do nothing;
 select * into current_state from public.project_states where project_id=target_project for update;
 content := current_state.payload;
 if jsonb_typeof(content->'raw') is distinct from 'array' or jsonb_typeof(content->'cards') is distinct from 'array'
  or jsonb_typeof(content->'cores') is distinct from 'array' or jsonb_typeof(content->'events') is distinct from 'array' then
  raise exception 'Workspace payload must contain raw/cards/cores/events arrays';
 end if;

 for actor in select * from (values
  (author_id::uuid,'【検証用】高橋 直人','cad-designer-1@demo.invalid','designer'),
  (reviewer_id::uuid,'【検証用】鈴木 美咲','cad-designer-2@demo.invalid','designer'),
  (senior_id::uuid,'【検証用】佐々木 健','cad-senior@demo.invalid','senior'),
  (it_id::uuid,'【検証用】伊藤 遥','cad-it@demo.invalid','it')
 ) as accounts(id,nickname,email,role) loop
  insert into public.app_users(id,nickname,email,password_hash)
  values(actor.id,actor.nickname,actor.email,null) on conflict(id) do nothing;
  if not exists(select 1 from public.app_users where id=actor.id and email=actor.email and nickname=actor.nickname and password_hash is null)
   or exists(select 1 from public.auth_passkeys where user_id=actor.id) then
   raise exception 'Demo identity conflicts with an existing user: %',actor.id;
  end if;
  insert into public.memberships(project_id,user_id,display_name,role)
  values(target_project,actor.id,actor.nickname,actor.role) on conflict(project_id,user_id) do nothing;
 end loop;

 route := jsonb_build_array(
  jsonb_build_object('type','review','label','設計条件・根拠確認','assignees',jsonb_build_array(author_id)),
  jsonb_build_object('type','review','label','図面・モデル整合確認','assignees',jsonb_build_array(reviewer_id)),
  jsonb_build_object('type','final','label','最終入庫判定','assignees',jsonb_build_array(reviewer_id,senior_id))
 );

 for source in select * from (values
  (1,'アセンブリ変更時の干渉・すきま確認','変更の影響範囲','core','重要','P1','主知識',
   'カバー、ブラケット、配管など複数部品が近接し、単一部品の位置や形状を変更する場合。',
   '最新版の参照部品を読み込み、静的干渉、必要すきま、組付け順序、工具の進入方向を別々に確認する。検出箇所は部品番号と姿勢を付けて記録する。',
   '干渉解析がゼロでも、工具が入らない、配管を組み付けられないなどの問題は残りうる。',
   '必要すきまは温度、変形、製造ばらつき、適用基準に基づいて決める。本例はすきまの数値を規定しない。',
   E'[01] 高橋：カバー形状を変更したため周辺部品との干渉を確認したい。\n[02] 鈴木：モデル参照版をそろえ、工具の進入と組付け順も分けて確認する。\n[03] 佐々木：必要すきまの選定根拠を残す。'),
  (2,'機能面を基準とした寸法・データムの整理','図面の更新管理','core','重要','P1','主知識',
   '取付面、位置決め穴、摺動面など、組付けや機能に関係する面から寸法を定義する場合。',
   '機能上の基準と測定基準を先に確認し、寸法の起点と方向を統一する。CADの原点と図面のデータムを同一視せず、必要な関係を明示する。',
   '加工と検査で異なる面を基準にすると、寸法を満たしていても組付け位置が意図とずれるおそれがある。',
   'データムや幾何公差の適用は採用規格と製品要求で個別確認する。本例は規格適合を保証しない。',
   E'[01] 高橋：CAD原点から寸法を入れているが取付面との関係が読みにくい。\n[02] 鈴木：機能基準と検査で当てる面を先に確認する。\n[03] 佐々木：基準の選定理由をレビュー記録に残す。'),
  (3,'板金モデルの曲げ条件と展開形状の確認','変更の影響範囲','core','標準','P2','副知識',
   '板厚、材質、曲げ半径、加工先の条件を用いて板金部品の展開図を作る場合。',
   '板金ルールと加工先の曲げ条件を照合し、曲げ逃げ、穴と曲げ線の関係、展開形状の重なりを確認する。加工先で未確認の係数を確定値として扱わない。',
   '同じ完成形でも曲げ条件により展開寸法や加工可否が変わるため。',
   '曲げ係数や最小距離の固定値は示していない。材質・設備・金型・試作結果に基づく確認が必要。',
   E'[01] 高橋：板金ルールを変更したところ展開寸法が変わった。\n[02] 鈴木：板厚と加工先条件の組合せを確認する。\n[03] 佐々木：穴近傍の変形と曲げ逃げも確認対象にする。'),
  (4,'位置決め穴の公差累積と組付け成立性','変更の影響範囲','review','重要','P1','主知識',
   '複数の穴、ピン、取付面を介して部品位置が決まるアセンブリを検討する場合。',
   '機能を決める寸法連鎖を特定し、前提とした公差・基準・評価方法を記録する。CADの名目形状だけで組付け成立を判断しない。',
   '名目寸法が一致しても、部品ごとのばらつきが累積すると組付けに影響するため。',
   '最悪値法と統計的手法の選択は生産条件と要求による。実測分布は未確認。',
   E'[01] 高橋：名目寸法ではピンと穴が合うが量産時のばらつきが心配。\n[02] 鈴木：基準と寸法連鎖を図示してから評価する。\n[03] 佐々木：設計条件の一次確認待ちとする。'),
  (5,'ボルト締結部の工具アクセス確認','変更の影響範囲','review','重要','P1','主知識',
   '周囲を壁、リブ、配線などで囲まれた締結部を設計・変更する場合。',
   '実際に使用する工具、締付け方向、操作に必要な範囲、作業順を確認し、工具モデルを使用する場合はその出典と版を記録する。',
   'ボルトが配置できても工具が入らない、回せない、保守時に外せない場合があるため。',
   '工具型番、締付け条件、作業標準は実案件で再確認する。模擬承認は技術的妥当性の証明ではない。',
   E'[01] 高橋：締結部の周囲にリブを追加した。\n[02] 鈴木：工具の挿入方向と操作範囲を確認し、模擬最終承認の1票目を記録した。\n[03] 佐々木：最終入庫の2票目は未処理。'),
  (6,'配線・ホースの曲げと可動時の接触確認','変更の影響範囲','returned','重要','P1','主知識',
   '可動部付近にケーブルやホースを配置し、取り回しを変更する場合。',
   'メーカー指定の曲げ条件、固定位置、可動範囲、余長と接触箇所を確認する。端位置だけでなく中間姿勢も確認する。',
   '端位置で問題がなくても中間姿勢で接触や過大な曲げが発生する可能性があるため。',
   'メーカーの許容曲げ条件と実機可動試験が未提出のため差戻し。確認済みとは扱わない。',
   E'[01] 高橋：端位置の取り回しモデルを作成した。\n[02] 鈴木：中間姿勢とメーカー仕様が不足しているため差し戻す。\n[03] 高橋：追加資料をそろえて改訂する。'),
  (7,'既存CADモデル流用時の条件差分','図面の更新管理','rejected','重要','P2','副知識',
   '過去案件のモデルを新しい使用条件へ流用しようとする場合。',
   '材質、荷重、温度、取付条件、規格、加工条件の差分を確認し、未評価項目を分離して再検討する。形状が似ていることだけで採用しない。',
   '過去案件で成立した条件が新案件にも当てはまるとは限らないため。',
   '本候補は適用条件の差分評価が不足しているため却下。再利用を一般的に禁止するものではない。',
   E'[01] 高橋：類似形状の既存部品を流用したい。\n[02] 鈴木：使用温度と荷重条件が異なる。\n[03] 佐々木：差分評価が不足しているため、この候補は却下する。'),
  (8,'ねじ穴深さと有効かみ合い範囲の整理','変更の影響範囲','draft','標準','P2','副知識',
   '止まりねじ穴とボルトを組み合わせる部位で板厚や締結部品を変更する場合。',
   '穴深さ、ねじ有効部、入口面取り、ボルト先端と底面の関係を図示し、材料と締結条件に応じて有効かみ合いを評価する。',
   'CADの外観だけではボルトの底付きや不十分なかみ合いを判断しにくいため。',
   '必要かみ合い長さの一律値は示さない。材質、強度区分、荷重、メーカー条件は別途確認する。',
   E'[01] 高橋：板厚変更に伴いボルト長さを見直す。\n[02] 鈴木：穴深さとねじ有効部を分けて整理する。\n[03] 高橋：申請前の草案として保存する。'),
  (9,'CAD属性とBOMの部品番号・数量整合','図面の更新管理','draft','標準','P2','副知識',
   'モデル属性から部品表を出力し、構成変更や抑制部品を含むデータを共有する場合。',
   '部品番号、改訂、材質、数量、抑制状態を照合し、同名ファイルや表示名だけで同一部品と判定しない。設計判断とデータ運用の責任を分ける。',
   'CAD表示、部品表出力、管理データの差異により誤手配や確認漏れが発生しうるため。',
   '検証用IT担当者が作成した草案。IT担当者は承認・差戻し・却下を行えない。',
   E'[01] 伊藤：出力BOMとモデル構成の数量差分を調査した。\n[02] 鈴木：設計上の採否は設計者が判断する。\n[03] 伊藤：属性対応表を検証用の草案として登録する。'),
  (10,'図面改訂時の参照モデルと承認版の対応','図面の更新管理','draft','重要','P1','主知識',
   '参照モデルの改訂後に図面やナレッジを更新し、過去の承認版を追跡する場合。',
   '図面、モデル、原資料、カードの改訂対応を記録する。承認済みスナップショットは上書きせず、新しい版を別途確認・承認する。',
   '最新版への参照更新によって、過去の判断根拠が意図せず変わることを防ぐため。',
   '版1は模擬承認済み、現在の版2は追加資料を反映した未承認草案。版1の承認は版2へ引き継がない。',
   E'[01] 高橋：参照モデルを改訂したため図面との対応を見直す。\n[02] 鈴木：過去の承認版は固定して保持する。\n[03] 高橋：追加確認事項を版2の草案に記録する。'),
  (11,'樹脂部品の抜き勾配・肉厚確認の保留','変更の影響範囲','draft','参考','P3','副知識',
   '樹脂成形部品の形状検討で、成形方向や金型条件がまだ確定していない場合。',
   '成形方向、金型構成、材質、表面仕様を確認し、必要な抜き勾配と肉厚条件を加工先と照合する。未確定項目は保留する。',
   '形状だけでは成形・離型の可否を確定できず、加工条件とのすり合わせが必要なため。',
   '加工先条件が未確認であり申請不可の未解決サンプル。数値条件や採用可否は提示しない。',
   E'[01] 高橋：樹脂形状の初期モデルを作成した。\n[02] 鈴木：成形方向と加工先条件が未確定。\n[03] 高橋：抽出候補は未解決として保留する。'),
  (12,'可動機構の全姿勢と周辺部品確認','変更の影響範囲','review','重要','P1','主知識',
   'リンク、スライダ、回転カバーなど、可動範囲を持つアセンブリを変更する場合。',
   '端位置だけでなく中間姿勢、配線・配管、周辺部品への接触と必要な逃げを確認し、検討した姿勢と未評価範囲を記録する。',
   '端位置の確認だけでは途中で生じる接触や動作制約を見落とす可能性があるため。',
   '解析はモデルと拘束条件に依存する。実機評価、強度評価、安全性評価を代替しない。',
   E'[01] 高橋：可動範囲の代表姿勢を検証した。\n[02] 鈴木：一次確認は模擬完了、図面・モデル整合確認を進める。\n[03] 佐々木：未評価の姿勢と条件を明記する。')
 ) as examples(number,title,problem,status,importance,priority,category,conditions,action,rationale,limits,raw_text) loop
  raw_id := 'RAW-CAD-DEMO-'||lpad(source.number::text,3,'0');
  card_id := 'KC-CAD-DEMO-'||lpad(source.number::text,3,'0');
  core_id := 'CORE-CAD-DEMO-'||lpad(source.number::text,3,'0');
  if exists(select 1 from jsonb_array_elements(content->'cards') item where item->>'id'=card_id) then
   if not exists(select 1 from jsonb_array_elements(content->'cards') item where item->>'id'=card_id and item->>'demoDataset'=dataset) then
    raise exception 'Card ID conflict: %',card_id;
   end if;
   continue;
  end if;
  if exists(select 1 from jsonb_array_elements(content->'raw') item where item->>'id'=raw_id)
   or exists(select 1 from jsonb_array_elements(content->'cores') item where item->>'id'=core_id) then
   raise exception 'Raw or core ID conflict for %',card_id;
  end if;
  owner_id := case when source.number=9 then it_id else author_id end;
  created_at := batch_time+source.number*interval '1 hour';
  raw_record := jsonb_build_object('id',raw_id,'owner',owner_id,
   'text','【架空・検証専用】実案件・実図面・社内規格を参照していません。'||E'\n'||source.raw_text,
   'files','[]'::jsonb,'revision',1,'scope','project','createdAt',created_at,'demoDataset',dataset);
  card := jsonb_build_object('id',card_id,'rawId',raw_id,'rawRevision',1,'owner',owner_id,'version',1,'versions','[]'::jsonb,
   'title','【検証用】'||source.title,'problem',source.problem,'conditions',source.conditions,'action',source.action,'rationale',source.rationale,
   'limits',source.limits||' 内容は架空の教材であり、実製品への適用は個別の設計検証が必要。',
   'evidence',raw_id||' / 架空レビュー記録 [01]–[03]',
   'claim',case when source.status='draft' then 'unverified' else 'hypothesis' end,
   'resolved',source.number<>11,'simulation',true,'status',source.status,
   'route',case when source.status='draft' then '[]'::jsonb else route end,
   'step',case when source.status='core' or source.number=5 then 2 when source.number in (6,7,12) then 1 else 0 end,
   'votes',case when source.status='core' then jsonb_build_array(reviewer_id,senior_id) when source.number=5 then jsonb_build_array(reviewer_id) else '[]'::jsonb end,
   'importance',source.importance,'priority',source.priority,'category',source.category,'createdAt',created_at,'demoDataset',dataset);
  content := jsonb_set(content,'{events}',jsonb_build_array(jsonb_build_object('id',card_id||'-created',
   'actor',case when source.number=9 then '【検証用】伊藤 遥' else '【検証用】高橋 直人' end,
   'action','CAD検証データ生成','target',card_id,'detail','架空資料・模擬状態。実際の技術承認ではありません。',
   'time',created_at,'demoDataset',dataset))||(content->'events'));
  if source.status<>'draft' then
   content := jsonb_set(content,'{events}',jsonb_build_array(jsonb_build_object('id',card_id||'-workflow','actor','【検証用】鈴木 美咲',
    'action',case source.status when 'core' then '模擬最終承認・コア登録' when 'returned' then '差戻し（模擬）' when 'rejected' then '却下（模擬）' else '承認申請・確認待ち（模擬）' end,
    'target',card_id,'detail',source.limits,'time',created_at+interval '20 minutes','demoDataset',dataset))||(content->'events'));
  end if;
  if source.number=10 then
   snapshot := card||jsonb_build_object('status','core','route',route,'step',2,'votes',jsonb_build_array(reviewer_id,senior_id),'claim','hypothesis',
    'limits','【架空・検証専用】版1の模擬承認スナップショット。版2の変更は含まない。');
   raw_record := raw_record||jsonb_build_object('revision',2,
    'versions',jsonb_build_array(jsonb_build_object('revision',1,'text',raw_record->>'text')),
    'text',(raw_record->>'text')||E'\n\n[追加資料 2]\n【検証用】版2で参照モデル改訂時のチェック項目を追加。未承認。');
   card := card||jsonb_build_object('version',2,'rawRevision',2,'versions',jsonb_build_array(snapshot));
   content := jsonb_set(content,'{events}',jsonb_build_array(
    jsonb_build_object('id',card_id||'-v1-approved','actor','【検証用】佐々木 健','action','版1の模擬承認・コア登録','target',card_id,
     'detail','異なる2名（シニアを含む）による検証用承認。','time',created_at+interval '20 minutes','demoDataset',dataset),
    jsonb_build_object('id',card_id||'-v2-revised','actor','【検証用】高橋 直人','action','資料追加・版2草案','target',card_id,
     'detail','版1の承認は継承しない。','time',created_at+interval '40 minutes','demoDataset',dataset)
   )||(content->'events'));
  elsif source.status='core' then snapshot := card;
  else snapshot := null;
  end if;
  if snapshot is not null then
   content := jsonb_set(content,'{cores}',jsonb_build_array(jsonb_build_object('id',core_id,'cardId',card_id,'approvedVersion',1,
    'snapshot',snapshot,'approvers',jsonb_build_array(reviewer_id,senior_id),'approvedAt',created_at+interval '20 minutes','demoDataset',dataset))||(content->'cores'));
  end if;
  content := jsonb_set(jsonb_set(content,'{raw}',jsonb_build_array(raw_record)||(content->'raw')),'{cards}',jsonb_build_array(card)||(content->'cards'));
  added := added+1;
 end loop;
 if added>0 then
  select jsonb_agg(item order by (item->>'time')::timestamptz desc,item->>'id') into sorted_events from jsonb_array_elements(content->'events') item;
  content := jsonb_set(content,'{events}',sorted_events);
  update public.project_states set payload=content,revision=revision+1 where project_id=target_project;
 end if;
 raise notice 'CAD demo data appended: % cards. Existing content and authentication credentials were preserved.',added;
end $$;

commit;