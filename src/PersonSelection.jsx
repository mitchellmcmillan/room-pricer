import React from "react";
import PersonSquare from "./PersonSquare";

export default function PersonSelection({ people = [], onSelect, selectedIdx, chosenPeople = [] }) {
    const hasRoster = Array.isArray(people) && people.length > 0;
    return (
        <div style={{ padding: 32 }}>
            <h2>Who are you?</h2>
            {hasRoster ? (
                <div style={{ display: "flex", gap: 24, justifyContent: "center", alignItems: "center", flexWrap: "wrap" }}>
                    {people.map((p, idx) => (
                        <PersonSquare
                            key={`${p.name}-${idx}`}
                            name={p.name}
                            emoji={p.emoji}
                            onClick={() => !chosenPeople.includes(idx) && onSelect(idx)}
                            style={{
                                cursor: chosenPeople.includes(idx) ? "not-allowed" : "pointer",
                                opacity: chosenPeople.includes(idx) ? 0.5 : 1,
                                border: selectedIdx === idx ? "3px solid #1976d2" : "none",
                            }}
                            disabled={chosenPeople.includes(idx)}
                        />
                    ))}
                </div>
            ) : (
                <div style={{ textAlign: "center", color: "#666", marginTop: 16 }}>
                    Waiting for roster to load...
                </div>
            )}
        </div>
    );
}
