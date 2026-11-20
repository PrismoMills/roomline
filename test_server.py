"""Integration checks for authorization, persistence, and collaboration state."""

import base64
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from server import app, initialize, connect


class RoomlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app.config.update(TESTING=True, DATABASE=str(Path(self.temp.name) / 'test.db'))
        initialize()
        self.alice, self.bob, self.cara = [app.test_client() for _ in range(3)]
        self.users = []
        for client, name in zip((self.alice, self.bob, self.cara), ('alice', 'bob', 'cara')):
            response = client.post('/api/register', json=dict(username=name, nickname=name.title(), password='testpass123'))
            self.assertEqual(response.status_code, 200)
            self.users.append(response.json['user'])
        self.room_id = self.alice.post('/api/rooms', json=dict(name='Design studio')).json['id']
        self.path = f'/api/rooms/{self.room_id}'
        self.invite = self.alice.get(self.path).json['room']['invite']
        self.bob.post('/api/join', json=dict(invite=self.invite))

    def tearDown(self):
        self.temp.cleanup()

    def test_membership_owner_and_room_lifecycle(self):
        self.assertEqual(self.cara.get(self.path).status_code, 403)
        self.assertEqual(self.bob.post(self.path+'/clear', json={}).status_code, 403)
        self.assertEqual(self.bob.post(self.path+'/manage', json=dict(action='kick', target=self.users[0]['id'])).status_code, 403)
        self.assertEqual(self.alice.post(self.path+'/manage', json=dict(action='kick', target=self.users[1]['id'])).status_code, 200)
        self.assertEqual(self.bob.get(self.path).status_code, 403)
        self.assertEqual(self.bob.post('/api/join', json=dict(invite=self.invite)).status_code, 403)
        self.alice.post(self.path+'/manage', json=dict(action='restore', target=self.users[1]['id']))
        self.bob.post('/api/join', json=dict(invite=self.invite))
        self.cara.post('/api/join', json=dict(invite=self.invite))
        self.alice.post(self.path+'/manage', json=dict(action='leave', successor=self.users[2]['id']))
        self.assertEqual(self.cara.get(self.path).json['room']['owner'], self.users[2]['id'])
        self.cara.post(self.path+'/manage', json=dict(action='leave'))
        self.assertEqual(self.bob.get(self.path).json['room']['owner'], self.users[1]['id'])
        self.bob.post(self.path+'/manage', json=dict(action='dissolve'))
        self.assertEqual(self.bob.get(self.path).status_code, 404)

    def test_strokes_messages_and_durable_history(self):
        drawing = dict(id='stroke-1', tool='pen', color='#35445e', width=3, points=[[.1, .2], [.4, .5]])
        for _ in range(2):
            self.assertEqual(self.alice.post(self.path+'/stroke', json=drawing).status_code, 200)
        self.assertEqual(len(self.bob.get(self.path).json['strokes']), 1)
        self.assertEqual(self.bob.post(self.path+'/stroke', json=drawing).status_code, 409)
        self.bob.post(self.path+'/undo', json={})
        self.assertEqual(len(self.alice.get(self.path).json['strokes']), 1)
        self.alice.post(self.path+'/undo', json={})
        self.assertEqual(len(self.bob.get(self.path).json['strokes']), 0)
        self.bob.post(self.path+'/message', json=dict(content='Hello <script> & world'))
        state = self.alice.get(self.path).json
        self.assertEqual(state['messages'][-1]['content'], 'Hello <script> & world')
        self.assertEqual(state['members'][0]['id'], self.users[1]['id'])
        self.assertGreater(state['cursor'], 0)
        initialize()
        self.assertEqual(self.alice.get(self.path).json['messages'][-1]['content'], 'Hello <script> & world')
        self.assertEqual(self.alice.post(self.path+'/stroke', json={**drawing, 'points': [[2, 0]]}).status_code, 400)

    def test_private_snapshot_survives_leaving(self):
        image = io.BytesIO()
        Image.new('RGB', (20, 10), 'white').save(image, 'PNG')
        encoded = 'data:image/png;base64,'+base64.b64encode(image.getvalue()).decode()
        response = self.alice.post('/api/snapshots', json=dict(name='Sketch', room_id=self.room_id, image=encoded))
        self.assertEqual(response.status_code, 200)
        snapshot_id = response.json['id']
        route = '/api/snapshots/'+snapshot_id
        self.assertEqual(self.bob.get(route+'/image').status_code, 404)
        self.assertEqual(self.bob.delete(route).status_code, 404)
        self.alice.post(self.path+'/manage', json=dict(action='leave'))
        self.assertEqual(self.alice.get(route+'/image').status_code, 200)
        self.alice.patch(route, json=dict(name='Renamed'))
        self.assertEqual(self.alice.get('/api/snapshots').json['snapshots'][0]['name'], 'Renamed')
        self.alice.delete(route)
        self.assertEqual(self.alice.get('/api/snapshots').json['snapshots'], [])

    def test_login_logout_profile(self):
        self.alice.post('/api/logout', json={})
        self.assertEqual(self.alice.get('/api/me').status_code, 401)
        self.assertEqual(self.alice.post('/api/login', json=dict(username='alice', password='bad')).status_code, 401)
        self.alice.post('/api/login', json=dict(username='alice', password='testpass123'))
        self.alice.post('/api/profile', json=dict(nickname='Alicia', current_password='testpass123', password='changedpass'))
        self.assertEqual(self.alice.get('/api/me').json['user']['nickname'], 'Alicia')
        self.assertEqual(self.alice.get('/avatar/'+self.users[0]['id']).status_code, 200)
        self.assertEqual(self.alice.post('/api/rooms', json=dict(name='x'), headers={'Origin':'https://other.example'}).status_code, 403)
        with connect() as db:
            self.assertNotIn('changedpass', db.execute('SELECT password FROM users WHERE username=?', ('alice',)).fetchone()[0])

    def test_two_accounts_share_browser_cookies_but_keep_tab_identity(self):
        browser = app.test_client()
        first = browser.post('/api/login', json=dict(username='alice', password='testpass123')).json
        second = browser.post('/api/login', json=dict(username='bob', password='testpass123')).json
        first_headers = {'X-Roomline-Session': first['session_id']}
        second_headers = {'X-Roomline-Session': second['session_id']}
        self.assertEqual(browser.get('/api/me', headers=first_headers).json['user']['username'], 'alice')
        self.assertEqual(browser.get('/api/me', headers=second_headers).json['user']['username'], 'bob')
        browser.post(self.path+'/message', headers=second_headers, json=dict(content='From Bob'))
        self.assertEqual(browser.get(self.path, headers=first_headers).json['messages'][-1]['user_id'], second['user']['id'])
        browser.post('/api/logout', headers=second_headers, json={})
        self.assertEqual(browser.get('/api/me', headers=first_headers).status_code, 200)
        self.assertEqual(browser.get('/api/me', headers=second_headers).status_code, 401)

    def test_random_successor_notification_and_plain_avatar(self):
        self.alice.post(self.path+'/manage', json=dict(action='leave'))
        state = self.bob.get(self.path).json
        self.assertEqual(state['room']['owner'], self.users[1]['id'])
        notices = self.bob.get('/api/notifications').json['notifications']
        self.assertEqual(len(notices), 1)
        self.assertIn('randomly selected', notices[0]['content'])
        self.assertEqual(self.cara.get('/api/notifications').json['notifications'], [])
        self.bob.post(f"/api/notifications/{notices[0]['id']}/read", json={})
        self.assertEqual(self.bob.get('/api/notifications').json['notifications'], [])
        avatar = self.bob.get('/avatar/'+self.users[1]['id']).get_data(as_text=True)
        self.assertIn('<circle cx="40" cy="27" r="13"', avatar)
        self.assertIn('M10 80 L14 67 C20 53', avatar)
        self.assertNotIn('stroke=', avatar)
        self.assertNotIn('fill="none"', avatar)
        self.assertNotIn('r="37"', avatar)

    def test_cursor_requires_membership_and_valid_coordinates(self):
        route = self.path + '/cursor'
        self.assertEqual(self.cara.post(route, json=dict(visible=True, x=.2, y=.4)).status_code, 403)
        self.assertEqual(self.alice.post(route, json=dict(visible=True, x=2, y=.4)).status_code, 400)
        self.assertEqual(self.alice.post(route, json=dict(visible=True, x=.2, y=.4)).status_code, 200)
        self.assertEqual(self.alice.post(route, json=dict(visible=False)).status_code, 200)


if __name__ == '__main__':
    unittest.main()
