import { Tick } from './Icon';
import { useEffect, useId, useRef, useState } from 'react';
import { useHeightMorph } from './Collapse';
import { emptyPick, pickOption, pickOther, questionAnswers, questionsAnswered, type Approval, type ChatQuestion, type QuestionPick } from './chat-model';

// The agent's question, answered in the chat: Claude's AskUserQuestion, Codex's requestUserInput and Cursor's ask_question all arrive as `approval.questions`.
// One card holds every question the agent asked, so they are answered and sent together. Several questions are tabs (an answered one is ticked)
// and only one shows at a time, so the card stays low and its send button in view; picking a single-choice option moves on to the next
// unanswered question. Options carry their description on the same line; unless the agent forbids it there is always a row to type one's
// own answer, and a question with no options is just a text box.
export function QuestionCard({ approval, onAnswer }: { approval: Approval; onAnswer(allow: boolean, always: boolean, answers?: Record<string, string[]>): void }) {
  const questions = approval.questions ?? [], uid = useId();
  const [picks, setPicks] = useState<Record<string, QuestionPick>>({}), [active, setActive] = useState(0), [card, capture] = useHeightMorph<HTMLDivElement>();
  const answers = questionAnswers(questions, picks), ready = questionsAnswered(questions, answers), done = questions.filter(question => answers[question.id]?.length).length;
  const answered = (question: ChatQuestion) => Boolean(answers[question.id]?.length), tabs = questions.length > 1, advance = useRef(0);
  // "다음": the first unanswered question after this one (wrapping round), else simply the next tab.
  const open = questions.map((question, index) => answered(question) ? -1 : index).filter(index => index >= 0 && index !== active);
  const nextOpen = open.find(index => index > active) ?? open[0] ?? Math.min(active + 1, questions.length - 1);
  const go = (index: number) => { if (index === active || index < 0 || index >= questions.length) return; capture(); setActive(index); };
  useEffect(() => () => clearTimeout(advance.current), []);
  const update = (question: ChatQuestion, next: QuestionPick, chose = false) => {
    setPicks(current => ({ ...current, [question.id]: next }));
    // A single choice is the whole answer: a beat later (so the pick is seen), go to the next question still unanswered.
    if (!chose || question.allowMultiple || !tabs) return;
    const after = { ...answers, [question.id]: next.options }, at = questions.findIndex((item, index) => index !== active && !(after[item.id]?.length));
    clearTimeout(advance.current);
    if (at >= 0) advance.current = window.setTimeout(() => go(at), 260);
  };
  const submit = () => { if (ready) onAnswer(true, false, answers); };
  const title = approval.tool === 'AskUserQuestion' || approval.tool === '질문' ? '질문' : approval.tool;
  return <div ref={card} className="chat-question" role="group" aria-label={`에이전트의 ${title}`} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}>
    <header><span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">help</span><strong>{title}</strong>
      <span>{questions.length > 1 ? `${questions.length}개 질문에 답해 주세요` : '답변을 기다리고 있어요'}</span></header>
    {tabs && <div className="chat-q-tabs" role="tablist" aria-label="질문" onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); go(active + (event.key === 'ArrowRight' ? 1 : -1)); } }}>
      {questions.map((question, index) => <button key={question.id} type="button" role="tab" aria-selected={index === active} tabIndex={index === active ? 0 : -1} data-answered={answered(question) || undefined} onClick={() => go(index)} title={question.prompt}>
        <span className="chat-q-step" aria-hidden="true">{answered(question) ? '✓' : index + 1}</span>{question.header || `질문 ${index + 1}`}</button>)}
    </div>}
    {questions.map((question, index) => {
      if (tabs && index !== active) return null;
      const pick = picks[question.id] ?? emptyPick(question), name = `${uid}-${question.id}`, hasOptions = Boolean(question.options?.length), typing = pick.other !== null;
      const kind = question.allowMultiple ? 'checkbox' : 'radio';
      return <fieldset className="chat-q" key={question.id} role={tabs ? 'tabpanel' : undefined}>
        <legend>{question.header && !tabs && <em className="chat-q-tag">{question.header}</em>}<span>{question.prompt}</span>{question.allowMultiple && <small>여러 개 선택할 수 있어요</small>}</legend>
        <div className="chat-q-options">
          {question.options?.map((option, at) => {
            const on = pick.options.includes(option.id);
            return <label key={option.id} className={`chat-q-option${on ? ' on' : ''}`}>
              <input type={kind} name={name} checked={on} onChange={() => update(question, pickOption(question, pick, option.id), true)} />
              <span className="chat-q-mark" aria-hidden="true"><Tick size={10} /></span>
              <span className="chat-q-text"><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
            </label>;
          })}
          {(question.allowOther || !hasOptions) && <label className={`chat-q-option other${typing && pick.other ? ' on' : ''}`}>
            {hasOptions && <><input type={kind} name={name} checked={typing} aria-label="직접 입력" onChange={() => update(question, pickOther(question, pick, typing && question.allowMultiple ? null : ''))} /><span className="chat-q-mark" aria-hidden="true"><Tick size={10} /></span></>}
            <input className="chat-q-input" type={question.secret ? 'password' : 'text'} aria-label={hasOptions ? `${question.prompt} — 직접 입력` : question.prompt}
              placeholder={hasOptions ? '직접 입력…' : '답변을 입력하세요'} value={pick.other ?? ''} autoComplete="off"
              onFocus={() => { if (!typing) update(question, pickOther(question, pick, '')); }} onChange={event => update(question, pickOther(question, pick, event.target.value))} />
          </label>}
        </div>
      </fieldset>;
    })}
    <footer>
      {/* Several questions: "다음" (to the next one still unanswered) until every one is answered, then that same button becomes "답변 보내기". */}
      {tabs && !ready ? <button type="button" className="primary" onClick={() => go(nextOpen)}>다음</button>
        : <button type="button" className="primary" disabled={!ready} onClick={submit}>답변 보내기</button>}
      <button type="button" onClick={() => onAnswer(false, false)} title={tabs ? `질문 ${questions.length}개 모두 답하지 않고 넘어갑니다. 에이전트는 스스로 판단해 이어갑니다.` : '답하지 않고 넘어갑니다. 에이전트는 스스로 판단해 이어갑니다.'}>{tabs ? '모두 건너뛰기' : '건너뛰기'}</button>
      <span className="chat-q-hint">{ready ? 'Ctrl/⌘+Enter로 보내기' : `${done}/${questions.length}개 답변함`}</span>
    </footer>
  </div>;
}

// The same questions read-only, for the tool card in the thread (instead of the raw JSON input).
export function QuestionList({ questions }: { questions: any[] }) {
  return <div className="chat-q-readonly">{questions.map((question, index) => <div key={index}>
    <p>{question?.header && <em className="chat-q-tag">{String(question.header)}</em>}<b>{String(question?.question ?? '')}</b>{question?.multiSelect && <small>여러 개 선택</small>}</p>
    {Array.isArray(question?.options) && <ul>{question.options.map((option: any, at: number) => <li key={at}><b>{String(option?.label ?? '')}</b>{option?.description && <small>{String(option.description)}</small>}</li>)}</ul>}
  </div>)}</div>;
}
