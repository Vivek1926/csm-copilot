import requests
import json
 
API_KEY = ""
PERSONA_ID = 5
 
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}
 
# Step 1: Create a chat session
def create_session(persona_id: int) -> str:
    response = requests.post(
        "https://astra.seclore.com/api/chat/create-chat-session",
        headers=HEADERS,
        json={"persona_id": persona_id},
    )
    # response = requests.get(
    #     "https://astra.seclore.com/api/persona",
    #     headers=HEADERS,
    # )
    print(response.status_code)
    print(response.text)
    response.raise_for_status()
    return response.json()["chat_session_id"]
 
# Step 2: Send a message (non-streaming) and print the parsed answer
def send_message(chat_session_id: str, message: str) -> None:
    response = requests.post(
        "https://astra.seclore.com/api/chat/send-chat-message",
        headers=HEADERS,
        json={
            "chat_session_id": chat_session_id,
            "message": message,
            "stream": False,
        },
    )
    response.raise_for_status()
    data = response.json()

    print("\n=== Answer ===")
    print(data.get("answer_citationless") or data.get("answer", "")) 

if __name__ == "__main__":
    session_id = create_session(PERSONA_ID)
    print(f"Session created: {session_id}")
 
    send_message(session_id, "Does Seclore support file protection only through the Desktop Client, or are APIs available for programmatic file protection? Give me a to-the-point answer without filler sentences & answer should be very quick")
 