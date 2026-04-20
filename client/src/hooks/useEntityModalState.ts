import { useState, useCallback } from "react";

/**
 * Generic hook that manages the "open modal + selected entity" state machine
 * shared by Leads, Estimates, and Jobs pages.
 *
 * Usage:
 *   const { activeModal, setActiveModal, closeModal } = useEntityModalState<MyModal>();
 */
export function useEntityModalState<T>() {
  const [activeModal, setActiveModal] = useState<T | null>(null);

  const closeModal = useCallback(() => setActiveModal(null), []);

  return { activeModal, setActiveModal, closeModal };
}
