import React, { useState } from "react";

export default function PersonSquare({
    name = "Person 1",
    emoji = "🙂",
    background = "#f5f5f5",
    border = "2px solid #ccc",
    onClick,
    disabled = false // <-- add disabled prop
}) {
    const size = 120;
    const [hovered, setHovered] = useState(false);
    // Minor darken background color on hover
    function darkenColor(hex, amount = 6) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
        let r = parseInt(hex.substring(0, 2), 16);
        let g = parseInt(hex.substring(2, 4), 16);
        let b = parseInt(hex.substring(4, 6), 16);
        r = Math.max(0, r - amount);
        g = Math.max(0, g - amount);
        b = Math.max(0, b - amount);
        return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    }
    const bg = hovered ? darkenColor(background, 6) : background;
    return (
        <div
            style={{
                width: size,
                height: size,
                borderRadius: 8,
                backgroundColor: bg,
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
            onMouseEnter={() => !disabled && setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={(!disabled && typeof onClick === 'function') ? onClick : undefined}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
        >
            <div style={{ fontWeight: "bold", fontSize: 22, height: '66%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: "10%" }}>{name}</div>
            <div style={{ fontSize: 48, height: '34%', width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>{emoji}</div>
        </div>
    );
}
