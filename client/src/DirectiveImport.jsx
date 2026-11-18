import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Upload } from 'lucide-react';
import { MAX_LEDGER_BYTES, directiveKinds, parseLedger } from '../../shared/directives.js';

export default function DirectiveImport({ command, busy, showCards, back }) {
    const [json, setJson] = useState(''), [filename, setFilename] = useState('');
    const [pasteOpen, setPasteOpen] = useState(false);
    const [consent, setConsent] = useState(false), [reading, setReading] = useState(false);
    const [error, setError] = useState(''), [result, setResult] = useState(null);
    const completionHeading = useRef(null);
    useEffect(() => { if (result) completionHeading.current?.focus(); }, [result]);
    async function readFile(event) {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        setError('');
        if (!/\.json$/i.test(file.name)) { setError('拡張子 .json の台帳ファイルを選択してください。'); return; }
        if (file.size > MAX_LEDGER_BYTES) { setError('台帳ファイルは 1 MiB 以下にしてください。'); return; }
        setReading(true);
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            setJson(text); setFilename(file.name); setPasteOpen(false);
        } catch { setError('ファイルを読み込めませんでした。UTF-8 の JSON を選択してください。'); }
        finally { setReading(false); }
    }
    async function submit(event) {
        event.preventDefault();
        if (busy || reading || !consent || !json.trim()) return;
        setError('');
        let ledger;
        try { ledger = parseLedger(json); } catch (e) { setError(e.message); return; }
        const imported = await command('import_directives', { ledger: json, filename: filename || undefined, consent });
        if (imported) {
            setResult({ ...imported, directiveIds: ledger.directives.map(d => d.id) });
            setJson(''); setFilename(''); setConsent(false); setPasteOpen(false);
        }
    }
    function openPaste() {
        if (filename) { setJson(''); setFilename(''); }
        setPasteOpen(true); setError('');
    }
    if (result) return <section className="panel create-panel directive-complete">
        <div className="section-title"><h2 tabIndex={-1} ref={completionHeading}><CheckCircle2 size={22} />台帳の取込が完了しました</h2></div>
        <p>新規草案: <strong>{result.imported} 件</strong> ／ スキップ（登録済み）: <strong>{result.skipped} 件</strong></p>
        <div className="hint">
            <strong>次にすること</strong>
            <p>{result.imported > 0
                ? '知識カード一覧で今回のカードを開き、内容と出典を確認してください。確認後、必要に応じて承認を申請できます。'
                : 'すべて登録済みのため、新しい草案は作成されませんでした。知識カード一覧で既存のカードを確認できます。'}</p>
        </div>
        <div className="form-bottom">
            <button type="button" className="secondary" onClick={() => setResult(null)}>続けて取り込む</button>
            <button type="button" className="primary" onClick={() => showCards(new Set(result.directiveIds))}>今回の知識カードを確認 <ArrowRight size={17} /></button>
        </div>
    </section>;
    return <form className="panel create-panel directive-import" onSubmit={submit}>
        <div className="section-title"><h2>知識台帳の取込</h2></div>
        <p>台帳の各指示を知識カードの草案として保存します。確認・承認が完了するまで、コアナレッジには入りません。</p>
        <section className="import-formats" aria-labelledby="import-formats-heading">
            <h3 id="import-formats-heading">対応形式</h3>
            <ul>
                <li><div><b>JSON 台帳</b><small>ファイルを選択、または JSON を貼り付け</small></div><span className="badge">利用可能</span></li>
                <li><div><b>その他の形式</b><small>今後の追加に備えた枠です。</small></div><span className="badge">未対応</span></li>
            </ul>
        </section>
        <label className="dropzone"><Upload size={22} /><b>台帳ファイル（UTF-8 / .json）</b><small>最大 500 件・1 MiB</small><input type="file" accept=".json,application/json" disabled={busy || reading} onChange={readFile} /></label>
        {filename && <div className="file-pill directive-file"><span>{filename}</span><button type="button" aria-label="選択したファイルを外す" disabled={busy || reading} onClick={() => { setFilename(''); setJson(''); setError(''); }}>×</button></div>}
        {pasteOpen
            ? <label>台帳 JSON<textarea rows={6} value={json} disabled={busy || reading} onChange={event => { setJson(event.target.value); setError(''); }} placeholder='{"directives": [...]}' spellCheck={false} /></label>
            : <div><button type="button" className="text-button" disabled={busy || reading} onClick={openPaste}>JSON を貼り付ける</button></div>}
        <label className="checkbox"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />この台帳をワークスペース内で保存・利用する権限があります。</label>
        {error && <p className="alert" role="alert">{error}</p>}
        <div className="form-bottom">
            <button type="button" className="secondary" disabled={busy || reading} onClick={back}>資料の追加に戻る</button>
            <button className="primary" disabled={busy || reading || !consent || !json.trim()}><Upload size={17} />草案として取り込む</button>
        </div>
    </form>;
}

export function DirectiveFields({ directive: d, batch }) {
    const fields = [
        ['指示 ID', d.id], ['種類', `${directiveKinds[d.kind]} (${d.kind})`], ['適用範囲', d.scope], ['指示内容', d.text],
        ['出典', d.source], ['トピック', d.topics.join(' / ')], ['照合語', d.match?.join(' / ')],
        ['再確認', d.reconfirmed], ['逸脱記録', d.violated_by], ['備考', d.note]
    ];
    return <>
        <dl className="fields">{fields.filter(([, value]) => value).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
        {batch && (batch.filename || batch.note || batch.incomplete !== undefined || batch.incomplete_reason || batch.match_note || batch.sources || batch.kinds) && <details className="directive-metadata">
            <summary>取込元の台帳情報{batch.incomplete && '（未完了）'}</summary>
            <dl className="fields">{[
                ['ファイル', batch.filename], ['台帳の注記', batch.note], ['確認状況・限界', batch.incomplete_reason], ['照合語の注記', batch.match_note],
                ['台帳の種類定義', batch.kinds && Object.entries(batch.kinds).map(([key, value]) => `${key}: ${value}`).join('\n')],
                ['台帳の出典', batch.sources && Object.entries(batch.sources).map(([key, value]) => `${key}: ${value}`).join('\n')]
            ].filter(([, value]) => value).map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
        </details>}
    </>;
}

export function matchesCard(card, query) {
    const d = card.directive;
    return [card.id, card.title, card.problem, card.conditions, card.action, ...(d ? [d.id, d.kind, directiveKinds[d.kind], d.source, ...d.topics, ...(d.match || [])] : [])]
        .join(' ').toLowerCase().includes(query.trim().toLowerCase());
}
