import { useEffect, useRef, useState } from 'react';

const TYPING_INTERVAL_MS = 80;
const CATCH_UP = 8;

export function tokenize(text) {
  return text.match(/\S+\s*/g) || [];
}

export function nextRevealedCount(target, prevTarget, revealedCount, catchUp = CATCH_UP) {
  const tokens = tokenize(target);
  if (target && !target.startsWith(prevTarget)) return 0;
  const backlog = tokens.length - revealedCount;
  if (backlog <= 0) return Math.min(revealedCount, tokens.length);
  return Math.min(tokens.length, revealedCount + Math.max(1, Math.ceil(backlog / catchUp)));
}

export default function useTypewriter(target) {
  const [displayed, setDisplayed] = useState('');
  const prevTargetRef = useRef('');
  const revealedRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const tick = () => {
      const tokens = tokenize(target);
      if (tokens.length === 0) {
        revealedRef.current = 0;
        prevTargetRef.current = target;
        setDisplayed('');
        clearInterval(timerRef.current);
        timerRef.current = null;
        return;
      }
      revealedRef.current = nextRevealedCount(target, prevTargetRef.current, revealedRef.current);
      prevTargetRef.current = target;
      setDisplayed(tokens.slice(0, revealedRef.current).join(''));
      if (revealedRef.current >= tokens.length) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (!timerRef.current) {
      timerRef.current = setInterval(tick, TYPING_INTERVAL_MS);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [target]);

  return displayed;
}
