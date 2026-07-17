import React, { useLayoutEffect, useRef, useState } from "react";

const textFitsCircle = (textElement, circleElement) => {
    const circle = circleElement.getBoundingClientRect();
    const textRange = document.createRange();
    textRange.selectNodeContents(textElement);
    const text = textRange.getBoundingClientRect();
    const cx = circle.left + circle.width / 2;
    const cy = circle.top + circle.height / 2;
    const radius = Math.min(circle.width, circle.height) / 2 - 2;
    return [[text.left, text.top], [text.right, text.top], [text.left, text.bottom], [text.right, text.bottom]]
        .every(([x, y]) => Math.hypot(x - cx, y - cy) <= radius);
};

const useFittedCircleFontSize = (maxFontSize, text) => {
    const ref = useRef(null);
    const [fontSize, setFontSize] = useState(maxFontSize);

    useLayoutEffect(() => {
        const textElement = ref.current;
        const circleElement = textElement?.closest('[data-testid="room-circle"]');
        if (!textElement || !circleElement) return;

        let low = 1;
        let high = maxFontSize;
        for (let i = 0; i < 8; i += 1) {
            const candidate = (low + high) / 2;
            textElement.style.fontSize = `${candidate}px`;
            if (textFitsCircle(textElement, circleElement)) low = candidate;
            else high = candidate;
        }
        setFontSize(low);
    }, [maxFontSize, text]);

    return [ref, fontSize];
};

export default function RoomCircle({
    name = "Room 1",
    description = "Ground floor",
    price = "£605",
    numPeople = 0,
    emoji = "🛏️",
    animate = false,
    onSelect,
    isSelected = false,
    canSelect = true,
    progress,
}) {
    const [nameRef, nameFontSize] = useFittedCircleFontSize(28, name);
    const [descriptionRef, descriptionFontSize] = useFittedCircleFontSize(16, description);
    const getCircleStyles = (numPeople) => {
        if (numPeople === 0) {
            return {
                border: "4px solid #ccc",
                background: "#fff",
                color: "#333",
            };
        } else if (numPeople === 1) {
            return {
                border: "4px solid #4caf50",
                background: "#e8f5e9",
                color: "#333",
            };
        } else {
            return {
                border: "4px solid #f44336",
                background: "#ffebee",
                color: "#333",
            };
        }
    };

    const styles = getCircleStyles(numPeople);
    const size = 200;
    const strokeWidth = 6;
    const radius = (size / 2) - (strokeWidth / 2);
    const circumference = 2 * Math.PI * radius;
    // --- Remove internal progress animation ---
    // Use progress prop directly
    const progressValue = typeof progress === 'number' ? progress : 0;
    const offset = circumference * (1 - progressValue);
    // Choose colors based on numPeople
    let ringColor = '#e0e0e0'; // lighter grey
    let progressColor = '#888'; // darker grey
    if (numPeople === 1) {
        ringColor = '#a5d6a7'; // lighter green
        progressColor = '#43a047'; // slightly lighter green
    } else if (numPeople > 1) {
        ringColor = '#ffcdd2'; // lighter red
        progressColor = '#e53935'; // slightly lighter red
    }
    // Increase padding to ensure marker is fully visible
    return (
        <div
            style={{
                position: "relative",
                width: size + strokeWidth * 2,
                height: size + strokeWidth * 2,
                padding: strokeWidth,
                boxSizing: 'content-box',
                outline: isSelected ? '3px solid #1976d2' : 'none',
                cursor: canSelect ? 'pointer' : 'default',
            }}
            onClick={e => {
                if (canSelect && onSelect) onSelect(e);
            }}
        >
            <div
                data-testid="room-circle"
                className={canSelect ? "hover-dim" : undefined}
                style={{
                    ...styles,
                    borderRadius: "50%",
                    width: size,
                    height: size,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    padding: 0,
                    boxSizing: "border-box",
                    fontFamily: "sans-serif",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    position: "relative",
                    zIndex: 1,
                }}
            >
                <div
                    data-testid="room-name"
                    ref={nameRef}
                    style={{
                        fontWeight: "bold",
                        fontSize: nameFontSize,
                        height: "30%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        margin: 0,
                        padding: 0,
                        paddingTop: "7.5%",
                        paddingBottom: 0,
                        maxWidth: "calc(100% - 4px)",
                        whiteSpace: "nowrap",
                    }}
                >
                    {name}
                </div>
                <div
                    style={{
                        fontSize: 40,
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%"
                    }}
                >
                    {emoji}
                </div>
                <div
                    data-testid="room-description"
                    ref={descriptionRef}
                    style={{
                        fontSize: descriptionFontSize,
                        textAlign: "center",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        maxWidth: "calc(100% - 4px)",
                        whiteSpace: "nowrap",
                    }}
                >
                    {description}
                </div>
                <div
                    style={{
                        fontSize: 18,
                        fontWeight: "bold",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                    }}
                >
                    {price}
                </div>
                <div
                    style={{
                        fontSize: 18,
                        fontWeight: "bold",
                        height: "15%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        paddingBottom: "2.5%"
                    }}
                >
                    {numPeople}/1
                </div>
            </div>
            {
                animate && numPeople !== 1 && progressValue < 1 && (
                    <svg width={size} height={size} style={{ position: "absolute", top: strokeWidth, left: strokeWidth, zIndex: 10, pointerEvents: "none", overflow: 'visible' }}>
                        {/* Background ring */}
                        <circle
                            cx={size / 2}
                            cy={size / 2}
                            r={radius}
                            stroke={ringColor}
                            strokeWidth={strokeWidth}
                            fill="none"
                        />
                        {/* Progress ring - rotate -90deg to start at 12 o'clock */}
                        <circle
                            cx={size / 2}
                            cy={size / 2}
                            r={radius}
                            stroke={progressColor}
                            strokeWidth={strokeWidth}
                            fill="none"
                            strokeDasharray={circumference}
                            strokeDashoffset={offset}
                            style={{
                                transition: "none",
                                transform: "rotate(-90deg)",
                                transformOrigin: "50% 50%"
                            }}
                        />
                    </svg>
                )
            }
        </div >
    );
}
