import { useTranslations } from "next-intl";

interface PendingQuestion {
  questionId: string;
  question: string;
  options?: string[];
}

interface QuestionPanelProps {
  question: PendingQuestion;
  answer: string;
  onAnswerChange: (v: string) => void;
  onSubmit: () => void;
}

const QuestionPanel = ({ question, answer, onAnswerChange, onSubmit }: QuestionPanelProps) => {
  const t = useTranslations("Panels");
  return (
    <div className="rounded-md border border-cyan-800 bg-cyan-900/20 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-cyan-300">{t("agentAsking")}</h3>
      <p className="text-sm text-zinc-200">{question.question}</p>
      {question.options ? (
        <div className="space-y-1">
          {question.options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswerChange(opt)}
              className={`block w-full rounded border px-3 py-1.5 text-left text-sm ${
                answer === opt ? "border-cyan-500 bg-cyan-900/40 text-cyan-200" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <textarea
          value={answer}
          onChange={(e) => onAnswerChange(e.target.value)}
          placeholder={t("typeAnswer")}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
          rows={3}
        />
      )}
      <button
        onClick={onSubmit}
        disabled={!answer.trim()}
        className="rounded bg-cyan-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
      >
        {t("submitAnswer")}
      </button>
    </div>
  );
};

export default QuestionPanel;
