import { useId, useState } from 'react';
import { emptyPick, pickOption, pickOther, questionAnswers, questionsAnswered, type Approval, type ChatQuestion, type QuestionPick } from './chat-model';

// The agent's question, answered in the chat: Claude's AskUserQuestion, Codex's requestUserInput and Cursor's ask_question all arrive as `approval.questions`.
// One card holds every question the agent asked, so they are answered and sent together. Options carry their description; unless the agent forbids it
// there is always a row to type one's own answer, and a question with no options is just a text box.
export function QuestionCard({ approval, onAnswer }: { approval: Approval; onAnswer(allow: boolean, always: boolean, answers?: Record<string, string[]>): void }) {
  const questions = approval.questions ?? [], uid = useId();
  const [picks, setPicks] = useState<Record<string, QuestionPick>>({});
  const answers = questionAnswers(questions, picks), ready = questionsAnswered(questions, answers), done = questions.filter(question => answers[question.id]?.length).length;
  const update = (question: ChatQuestion, next: QuestionPick) => setPicks(current => ({ ...current, [question.id]: next }));
  const submit = () => { if (ready) onAnswer(true, false, answers); };
  const title = approval.tool === 'AskUserQuestion' || approval.tool === '질문' ? '질문' : approval.tool;
  return <div className="chat-question" role="group" aria-label={`에이전트의 ${title}`} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}>
    <header><span className="icon material-symbols-outlined" style={{ fontSize: 16 }} aria-hidden="true">help</span><strong>{title}</strong>
      <span>{questions.length > 1 ? `${questions.length}개 질문에 답해 주세요` : '답변을 기다리고 있어요'}</span></header>
    {questions.map((question, index) => {
      const pick = picks[question.id] ?? emptyPick(question), name = `${uid}-${question.id}`, hasOptions = Boolean(question.options?.length), typing = pick.other !== null;
      const kind = question.allowMultiple ? 'checkbox' : 'radio';
      return <fieldset className="chat-q" key={question.id}>
        <legend>{question.header && <em className="chat-q-tag">{question.header}</em>}<span>{question.prompt}</span>{question.allowMultiple && <small>여러 개 선택할 수 있어요</small>}</legend>
        <div className="chat-q-options">
          {question.options?.map((option, at) => {
            const on = pick.options.includes(option.id);
            return <label key={option.id} className={`chat-q-option${on ? ' on' : ''}`}>
              <input type={kind} name={name} checked={on} autoFocus={index === 0 && at === 0} onChange={() => update(question, pickOption(question, pick, option.id))} />
              <span className="chat-q-mark" aria-hidden="true" />
              <span className="chat-q-text"><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
            </label>;
          })}
          {(question.allowOther || !hasOptions) && <label className={`chat-q-option other${typing && pick.other ? ' on' : ''}`}>
            {hasOptions && <><input type={kind} name={name} checked={typing} aria-label="직접 입력" onChange={() => update(question, pickOther(question, pick, typing && question.allowMultiple ? null : ''))} /><span className="chat-q-mark" aria-hidden="true" /></>}
            <input className="chat-q-input" type={question.secret ? 'password' : 'text'} autoFocus={!hasOptions && index === 0} aria-label={hasOptions ? `${question.prompt} — 직접 입력` : question.prompt}
              placeholder={hasOptions ? '직접 입력…' : '답변을 입력하세요'} value={pick.other ?? ''} autoComplete="off"
              onFocus={() => { if (!typing) update(question, pickOther(question, pick, '')); }} onChange={event => update(question, pickOther(question, pick, event.target.value))} />
          </label>}
        </div>
      </fieldset>;
    })}
    <footer>
      <button type="button" className="primary" disabled={!ready} onClick={submit}>답변 보내기</button>
      <button type="button" onClick={() => onAnswer(false, false)} title="답하지 않고 넘어갑니다. 에이전트는 스스로 판단해 이어갑니다.">건너뛰기</button>
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
