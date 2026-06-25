import React from "react";

export default function PersonSquare({
    name = "Person 1",
    emoji = "🙂",
    background = "#f5f5f5",
    border = "2px solid #ccc",
    onClick,
    disabled = false // <-- add disabled prop
}) {
    const size = 120;
    return (
        <div
            className="hover-dim"
            style={{
                width: size,
                height: size,
                borderRadius: 8,
                backgroundColor: background,
                border,
                boxSizing: 'border-box',
                position: 'relative',
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-start",
                fontFamily: "sans-serif",
                padding: 0,
                margin: 8,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                pointerEvents: disabled ? 'none' : 'auto',
            }}
            onClick={(!disabled && typeof onClick === 'function') ? onClick : undefined}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
        >
            <div style={{ fontWeight: "bold", fontSize: 22, height: '66%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: "10%" }}>{name}</div>
            <div style={{ fontSize: 48, height: '34%', width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>{emoji}</div>
        </div>
    );
}
